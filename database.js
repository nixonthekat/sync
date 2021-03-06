/*
The MIT License (MIT)
Copyright (c) 2013 Calvin Montgomery

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

var mysql = require("mysql-libmysqlclient");
var Config = require("./config.js");
var Logger = require("./logger.js");
var Rank = require("./rank.js");
var Media = require("./media.js").Media;
//var Server = require("./server.js");

var initialized = false;

exports.getConnection = function() {
    var db = mysql.createConnectionSync();
    db.connectSync(Config.MYSQL_SERVER, Config.MYSQL_USER,
                   Config.MYSQL_PASSWORD, Config.MYSQL_DB);
    if(!db.connectedSync()) {
        Logger.errlog.log("database.getConnection: DB connection failed");
        return false;
    }
    return db;
}

function sqlEscape(data) {
    if(data == null || data == undefined)
        return "NULL";
    else if(typeof data == "number")
        return data;
    else if(typeof data == "object")
        return "(object)";
    else if(typeof data == "string") {
        return data.replace("'", "\\'");
    }
}
exports.sqlEscape = sqlEscape;

exports.init = function() {
    if(initialized)
        return;

    var db = exports.getConnection();
    if(!db) {
        Logger.errlog.log("database.init: DB conection failed");
        return;
    }
    var query = "CREATE TABLE IF NOT EXISTS `channels` \
                    (`id` INT NOT NULL AUTO_INCREMENT, \
                     `name` VARCHAR(255) NOT NULL, \
                     PRIMARY KEY (`id`)) \
                     ENGINE = MyISAM;";
    var results = db.querySync(query);
    if(!results) {
        Logger.errlog.log("database.init: channel table init failed!");
        return false;
    }

    var query = "CREATE TABLE IF NOT EXISTS `registrations` \
                    (`id` INT NOT NULL AUTO_INCREMENT, \
                     `uname` VARCHAR(20) NOT NULL, \
                     `pw` VARCHAR(64) NOT NULL, \
                     `global_rank` INT NOT NULL, \
                     `session_hash` VARCHAR(64) NOT NULL, \
                     `expire` BIGINT NOT NULL, \
                     PRIMARY KEY (`id`)) \
                     ENGINE = MyISAM;";
    var results = db.querySync(query);
    if(!results) {
        Logger.errlog.log("database.init: registration table init failed!");
        return false;
    }

    var query = "CREATE TABLE IF NOT EXISTS `global_bans` \
                    (`ip` VARCHAR( 15 ) NOT NULL ,\
                    `note` VARCHAR( 255 ) NOT NULL ,\
                    PRIMARY KEY (`ip`)\
                    ) ENGINE = MYISAM";
    var results = db.querySync(query);
    if(!results) {
        Logger.errlog.log("database.init: global ban table init failed!");
        return false;
    }

    initialized = true;
    db.closeSync();
    return true;
}

var gbanTime = 0;
var gbans = {};
exports.checkGlobalBan = function(ip) {
    // Check database at most once per 5 minutes
    if(new Date().getTime() > gbanTime + 300000) {
        exports.refreshGlobalBans();
    }
    var parts = ip.split(".");
    var slash16 = parts[0] + "." + parts[1];
    var slash24 = slash16 + "." + parts[2];
    return (ip in gbans || slash16 in gbans || slash24 in gbans);
}

exports.refreshGlobalBans = function() {
    var db = exports.getConnection();
    if(!db) {
        return false;
    }
    // Check if channel exists
    var query = "SELECT * FROM global_bans WHERE 1";
    var results = db.querySync(query);
    if(!results) {
        Logger.errlog.log("loadGlobalBans: query failed");
        return false;
    }
    var rows = results.fetchAllSync();
    gbans = {};
    for(var i = 0; i < rows.length; i++) {
        gbans[rows[i].ip] = rows[i].note;
    }
    db.closeSync();
    gbanTime = new Date().getTime();
    return gbans;
}

exports.addGlobalBan = function(ip, reason) {
    var db = exports.getConnection();
    if(!db) {
        return false;
    }
    var query = "INSERT INTO global_bans VALUES ('{1}', '{2}')"
        .replace("{1}", sqlEscape(ip))
        .replace("{2}", sqlEscape(reason));
    var result = db.querySync(query);
    db.closeSync();
    return result;
}

exports.liftGlobalBan = function(ip) {
    var db = exports.getConnection();
    if(!db) {
        return false;
    }
    var query = "DELETE FROM global_bans WHERE ip='{}'"
        .replace("{}", sqlEscape(ip))
    var result = db.querySync(query);
    db.closeSync();
    return result;
}

exports.loadChannel = function(chan) {
    var db = exports.getConnection();
    if(!db) {
        chan.logger.log("!!! Could not connect to database");
        return;
    }
    // Check if channel exists
    var query = "SELECT * FROM channels WHERE name='{}'"
        .replace("{}", chan.name);
    var results = db.querySync(query);
    if(!results) {
        Logger.errlog.log("Channel.loadMysql: Channel query failed");
        return;
    }
    var rows = results.fetchAllSync();
    if(rows.length == 0) {
        Logger.syslog.log("Channel " + chan.name + " is unregistered.");
        return;
    }
    else if(rows[0].name != chan.name) {
        chan.name = rows[0].name;
    }
    chan.registered = true;

    // Load library
    var query = "SELECT * FROM chan_{}_library"
        .replace("{}", sqlEscape(chan.name));
    var results = db.querySync(query);
    if(!results) {
        Logger.errlog.log("Channel.loadMysql: failed to load library for " + chan.name);
        return;
    }
    var rows = results.fetchAllSync();
    for(var i = 0; i < rows.length; i++) {
        chan.library[rows[i].id] = new Media(rows[i].id, rows[i].title, rows[i].seconds, rows[i].type);
    }

    // Load bans
    var query = "SELECT * FROM chan_{}_bans"
        .replace("{}", sqlEscape(chan.name));
    var results = db.querySync(query);
    if(!results) {
        Logger.errlog.log("Channel.loadMysql: failed to load banlist for " + chan.name);
        return;
    }
    var rows = results.fetchAllSync();
    for(var i = 0; i < rows.length; i++) {
        chan.ipbans[rows[i].ip] = [rows[i].name, rows[i].banner];
    }

    chan.logger.log("*** Loaded channel from database");
    Logger.syslog.log("Loaded channel " + chan.name + " from database");
    db.closeSync();

}

exports.registerChannel = function(chan) {
    var db = exports.getConnection();
    if(!db) {
        chan.logger.log("!!! Could not connect to database");
        return false;
    }
    // Create library table
    var query= "CREATE TABLE `chan_{}_library` \
                    (`id` VARCHAR(255) NOT NULL, \
                    `title` VARCHAR(255) NOT NULL, \
                    `seconds` INT NOT NULL, \
                    `playtime` VARCHAR(8) NOT NULL, \
                    `type` VARCHAR(2) NOT NULL, \
                    PRIMARY KEY (`id`)) \
                    ENGINE = MyISAM;"
        .replace("{}", chan.name);
    var results = db.querySync(query);

    // Create rank table
    var query = "CREATE TABLE  `chan_{}_ranks` (\
                    `name` VARCHAR( 32 ) NOT NULL ,\
                    `rank` INT NOT NULL ,\
                    UNIQUE (\
                    `name`\
                    )\
                    ) ENGINE = MYISAM"
        .replace("{}", chan.name);
    results = db.querySync(query) || results;

    // Create ban table
    var query = "CREATE TABLE  `chan_{}_bans` (\
                    `ip` VARCHAR( 15 ) NOT NULL ,\
                    `name` VARCHAR( 32 ) NOT NULL ,\
                    `banner` VARCHAR( 32 ) NOT NULL ,\
                    PRIMARY KEY (\
                    `ip`\
                    )\
                    ) ENGINE = MYISAM"
        .replace("{}", chan.name);
    results = db.querySync(query) || results;

    // Insert into global channel table
    var query = "INSERT INTO channels (`id`, `name`) VALUES (NULL, '{}')"
        .replace("{}", sqlEscape(chan.name));
    results = db.querySync(query) || results;
    db.closeSync();
    return results;
}

exports.lookupChannelRank = function(channame, username) {
    var db = exports.getConnection();
    if(!db) {
        Logger.errlog.log("database.lookupChannelRank: DB connection failed");
        return Rank.Guest;
    }
    var query = "SELECT * FROM chan_{1}_ranks WHERE name='{2}'"
        .replace("{1}", sqlEscape(channame))
        .replace("{2}", sqlEscape(username));
    var results = db.querySync(query);
    if(!results) {
        return Rank.Guest;
    }
    var rows = results.fetchAllSync();
    if(rows.length == 0) {
        return Rank.Guest;
    }

    db.closeSync();
    return rows[0].rank;
}

exports.saveChannelRank = function(channame, user) {
    var db = exports.getConnection();
    if(!db) {
        Logger.errlog.log("database.saveChannelRank: DB connection failed");
        return false;
    }
    var query = "UPDATE chan_{1}_ranks SET rank='{2}' WHERE name='{3}'"
        .replace("{1}", sqlEscape(channame))
        .replace("{2}", sqlEscape(user.rank))
        .replace("{3}", sqlEscape(user.name));
    var results = db.querySync(query);
    // Gonna have to insert a new one, bugger
    if(!results.fetchAllSync) {
        var query = "INSERT INTO chan_{1}_ranks (`name`, `rank`) VALUES ('{2}', '{3}')"
            .replace("{1}", sqlEscape(channame))
            .replace("{2}", sqlEscape(user.name))
            .replace("{3}", sqlEscape(user.rank));
        results = db.querySync(query);
    }
    db.closeSync();
    return results;
}

exports.cacheMedia = function(channame, media) {
    var db = exports.getConnection();
    if(!db) {
        Logger.errlog.log("database.cacheMedia: DB connection failed");
        return false;
    }
    var query = "INSERT INTO chan_{1}_library VALUES ('{2}', '{3}', {4}, '{5}', '{6}')"
        .replace("{1}", sqlEscape(channame))
        .replace("{2}", sqlEscape(media.id))
        .replace("{3}", sqlEscape(media.title))
        .replace("{4}", sqlEscape(media.seconds))
        .replace("{5}", sqlEscape(media.duration))
        .replace("{6}", sqlEscape(media.type));
    var results = db.querySync(query);
    db.closeSync();
    return results;
}

exports.uncacheMedia = function(channame, id) {
    var db = exports.getConnection();
    if(!db) {
        Logger.errlog.log("database.uncacheMedia: DB connection failed");
        return false;
    }
    var query = "DELETE FROM chan_{1}_library WHERE id='{2}'"
        .replace("{1}", sqlEscape(channame))
        .replace("{2}", sqlEscape(id))
    var results = db.querySync(query);
    db.closeSync();
    return results;
}

exports.addChannelBan = function(channame, actor, receiver) {
    var db = exports.getConnection();
    if(!db) {
        Logger.errlog.log("exports.addChannelBan: DB connection failed");
        return false;
    }
    var query = "INSERT INTO chan_{1}_bans (`ip`, `name`, `banner`) VALUES ('{2}', '{3}', '{4}')"
        .replace("{1}", sqlEscape(channame))
        .replace("{2}", sqlEscape(receiver.ip))
        .replace("{3}", sqlEscape(receiver.name))
        .replace("{4}", sqlEscape(actor.name));
    results = db.querySync(query);
    db.closeSync();
    return results;
}

exports.removeChannelBan = function(channame, ip) {
    var db = exports.getConnection();
    if(!db) {
        Logger.errlog.log("exports.removeChannelBan: DB connection failed");
        return false;
    }
    var query = "DELETE FROM chan_{1}_bans WHERE `ip` = '{2}'"
        .replace("{1}", sqlEscape(channame))
        .replace("{2}", sqlEscape(ip));
    results = db.querySync(query);
    db.closeSync();
    return results;
}

exports.getChannelRanks = function(channame) {
    var db = exports.getConnection();
    if(!db) {
        return false;
    }

    var query = "SELECT * FROM chan_{}_ranks WHERE 1"
        .replace("{}", sqlEscape(channame));

    var results = db.querySync(query);
    if(results) {
        var rows = results.fetchAllSync();
        db.closeSync();
        return rows;
    }
    else {
        return [];
    }
}
