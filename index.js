var fs = require('fs'),
    hapi = require('hapi'),
    pg = require('pg'),
    boom = require('boom'),
    pg_copy = require('pg-copy-streams'),
    hstore = require('pg-hstore')(),
    queue = require('queue-async'),
    reformatCsv = require('./lib/reformat-csv'),
    queries = require('./lib/queries');

var user = process.env.DBUsername || 'postgres';
var password = process.env.DBPassword || '';
var address = process.env.DBAddress || 'localhost';
var database = process.env.Database || 'tofix';
var path = process.env.UploadPath;

// short term, to prevent the need from building out user authentication until later
var uploadPassword = process.env.UploadPassword;

if (!path) return console.log('env variable UploadPath must be set');
if (!uploadPassword) return console.log('env variable UploadPassword must be set');

// from the db connection
var client, done;

// seconds to lock each item
var lockPeriod = 600;

var conString = 'postgres://' +
    user + ':' +
    password + '@' +
    address + '/' +
    database;

var server = new hapi.Server();
var port = 8000;

server.connection({
    port: port,
    routes: {
        cors: true
    }
});

server.route({
    method: 'GET',
    path: '/status',
    handler: function(request, reply) {
        reply({
            status: 'a ok'
        });
    }
});

server.route({
    method: 'POST',
    path: '/track/{task}',
    handler: function(request, reply) {
        var table = request.params.task;
        var attributes = request.payload.attributes;
        if (!attributes) return reply(boom.badRequest('missing attributes'));

        // don't wait
        reply();
        track(table, request.payload.time, attributes, function(err, results) {
            if (err) console.error('/track err', err);
        });
    }
});

function track(table, time, attributes, callback) {
    if (typeof attributes.key !== 'undefined') { // filter undefined track after a task was complete
        // validate time, is int, is within range
        time = time || Math.round(+new Date() / 1000);
        table = table.replace(/[^a-zA-Z]+/g, '').toLowerCase();
        var query = 'INSERT INTO ' + table + '_stats VALUES($1, $2);';

        client.query(query, [time, hstore.stringify(attributes)], function(err, results) {
            if (err) return callback(err);
            callback(null, results);
        });
    }
}

server.route({
    method: 'GET',
    path: '/count/{task}',
    handler: function(request, reply) {
        var table = request.params.task.replace(/[^a-zA-Z]+/g, '').toLowerCase();

        queue(1)
            .defer(function(cb) {
                // overall count
                client.query('SELECT count(*) FROM ' + table + ';', cb);
            })
            .defer(function(cb) {
                // unfixed items
                client.query('SELECT count(*) FROM ' + table + ' WHERE time != 2147483647;', cb);
            })
            .defer(function(cb) {
                // items that are active
                client.query('SELECT count(*) from ' + table + ' WHERE time > ' + Math.round(+new Date() / 1000) + ' AND time != 2147483647;', cb);
            })
            .awaitAll(function(err, results) {
                if (err) return reply(boom.badRequest(err));
                reply({
                    total: parseInt(results[0].rows[0].count),
                    available: parseInt(results[1].rows[0].count),
                    active: parseInt(results[2].rows[0].count)
                });
            });
    }
});

server.route({
    method: 'GET',
    path: '/count_history/{task}/{grouping}',
    handler: function(request, reply) {
        var table = request.params.task.replace(/[^a-zA-Z]+/g, '').toLowerCase();
        var query = "SELECT count(*), attributes->'action' AS action, date_trunc($1, to_timestamp(time)) AS time FROM " + table + "_stats WHERE attributes->'action'='skip' OR attributes->'action'='edit' OR attributes->'action'='fix' OR attributes->'action'='noterror' GROUP BY date_trunc($1, to_timestamp(time)), attributes->'action' ORDER BY date_trunc($1, to_timestamp(time));";
        client.query(query, [request.params.grouping], function(err, results) {
            if (err) return reply(boom.badRequest(err));
            var times = {};

            results.rows.forEach(function(row) {
                var time = Math.round(+new Date(row.time) / 1000);
                if (!times[time]) times[time] = {};
                times[time][row.action] = parseInt(row.count);
            });

            var out = [];
            for (var time in times) {
                times[time].start = parseInt(time);
                out.push(times[time]);
            }

            reply({
                updated: Math.round(+new Date() / 1000),
                data: out
            });

        });
    }
});

server.route({
    method: 'GET',
    path: '/track/{task}/{key}:{value}/{to?}',
    handler: function(request, reply) {
        // gets results filtered by key:value or by date range
        // user:joey, filters from hstore
        // or
        // from:2015-03-17/to:2015-03-19, filters on time

        var table = request.params.task.replace(/[^a-zA-Z]+/g, '').toLowerCase();
        var query = 'SELECT time AS time, hstore_to_json_loose(attributes) AS attributes FROM ' + table + '_stats WHERE ';
        var params;

        if (request.params.key == 'from' && request.params.to) {
            var from = Date.parse(request.params.value) / 1000;
            var to = Date.parse(request.params.to.split(':')[1]) / 1000;
            // go to the end of the to date
            to = to + 86400;
            query += 'time > $1 and time < $2;';
            params = [from, to];
        } else if (request.params.key == 'from' && !request.params.to) {
            var from = Date.parse(request.params.value) / 1000;
            query += 'time > $1;';
            params = [from];
        } else {
            query += 'attributes->$1=$2 ORDER BY time ASC;';
            params = [request.params.key, request.params.value];
        }
        client.query(query, params, function(err, results) {
            if (err) return reply(boom.badRequest(err));
            reply({
                updated: Math.round(+new Date() / 1000),
                data: results.rows
            });
        });
    }
});

server.route({
    method: 'GET',
    path: '/track_stats/{task}/{from}/{to}',
    handler: function(request, reply) {
        // give stats for the given time period
        var from = Math.round(+new Date(request.params.from.split(':')[1]) / 1000);
        var to = Math.round(+new Date(request.params.to.split(':')[1]) / 1000);
        if (from == to) to = to + 86400;
        var table = request.params.task.replace(/[^a-zA-Z]+/g, '').toLowerCase();
        var query = "SELECT count(*), attributes->'user' AS user, attributes->'action' AS action FROM " + table + "_stats WHERE time < $1 AND time > $2 AND (attributes->'action'='edit' OR attributes->'action'='skip' OR attributes->'action'='fix' OR attributes->'action'='noterror') GROUP BY attributes->'user', attributes->'action' ORDER BY attributes->'user';";
        client.query(query, [to, from], function(err, results) {
            if (err) {
                reply(boom.badRequest(err));
                return false;
            }

            var users = {};
            results.rows.forEach(function(row) {
                if (row.user && row.user.trim()) {
                    if (!users[row.user]) {
                        users[row.user] = {};
                    }
                    users[row.user][row.action] = parseInt(row.count);
                }
            });

            users = Object.keys(users).map(function(user) {
                var out = users[user];
                out.user = user;
                return out;
            });

            reply({
                updated: Math.round(+new Date() / 1000),
                stats: users
            });
        });
    }
});

server.route({
    method: 'POST',
    path: '/task/{task}',
    handler: function(request, reply) {
        var table = request.params.task.replace(/[^a-zA-Z]+/g, '').toLowerCase();
        var query = 'SELECT key, value FROM task_' + table + '($1,$2)';
        var now = Math.round(+new Date() / 1000);
        client.query(query, [lockPeriod, now], function(err, results) {
            if (err) return reply(boom.badRequest(err));
            if (results.rows[0].key === 'complete') {
                return reply(boom.resourceGone(JSON.stringify({
                    key: results.rows[0].key,
                    value: JSON.parse(results.rows[0].value.split('|').join('"'))
                })));
            } else {
                return reply(JSON.stringify({
                    key: results.rows[0].key,
                    value: JSON.parse(results.rows[0].value.split('|').join('"'))
                }));
            }
        });
    }
});

server.route({
    method: 'POST',
    path: '/fixed/{task}',
    config: {
        payload: {
            output: 'data'
        }
    },
    handler: function(request, reply) {
        var table = request.params.task.replace(/[^a-zA-Z]+/g, '').toLowerCase();
        // 2147483647 is int max
        var query = 'UPDATE ' + table + ' SET time=2147483647 WHERE key=$1;';
        client.query(query, [request.payload.key], function(err, results) {
            if (err) return boom.badRequest(err);
            // check for a real update, err if not
            return reply('ok');
        });

        var attributes = {
            user: request.payload.user,
            key: request.payload.key,
            action: 'fix'
        };

        track(table, false, attributes, function(err, results) {
            if (err) console.error('/fixed tracking err', err);
        });

    }
});

server.route({
    method: 'POST',
    path: '/noterror/{task}',
    config: {
        payload: {
            output: 'data'
        }
    },
    handler: function(request, reply) {
        var table = request.params.task.replace(/[^a-zA-Z]+/g, '').toLowerCase();
        var query = 'UPDATE ' + table + ' SET time=2147483647 WHERE key=$1;';
        client.query(query, [request.payload.key], function(err, results) {
            if (err) return boom.badRequest(err);
            return reply('ok');
        });
        var attributes = {
            user: request.payload.user,
            key: request.payload.key,
            action: 'noterror'
        };

        track(table, false, attributes, function(err, results) {
            if (err) console.error('/Not a error tracking err', err);
        });
    }
});

server.route({
    method: 'GET',
    path: '/detail/{idtask}',
    handler: function(request, reply) {
        var idtask = request.params.idtask.replace(/[^a-zA-Z]+/g, '').toLowerCase();
        var query = 'SELECT id, title, source, owner, description, updated, status from task_details where id =  $1';
        var task = {};
        var cliente = client.query(query, [idtask], function(err, results) {
            if (err) return boom.badRequest(err);
            results.rows.forEach(function(row) {
                task.id = row.id;
                task.title = row.title;
                task.source = row.source;
                task.owner = row.owner;
                task.description = row.description;
                task.updated = row.updated;
                task.status = row.status;
            });
        });
        cliente.on('end', function(result) {
            return reply(JSON.stringify({
                task: task
            }));
        });
    }
});



server.route({
    method: 'POST',
    path: '/csv',
    config: {
        payload: {
            maxBytes: 200000000,
            output: 'stream',
            parse: true
        }
    },
    handler: function(request, reply) {
        // confirm db config vars are set
        // err immeditately if not
        var data = request.payload;

        if (!data.file ||
            (!data.password || data.password === '') ||
            (!data.name || data.name === '')) return reply(boom.badRequest('missing something'));

        if (data.password != uploadPassword) return reply(boom.unauthorized('invalid password'));

        if (data.file) {
            var name = data.file.hapi.filename;
            var taskName = data.name.replace(/[^a-zA-Z]+/g, '').toLowerCase();
            // just looking at the extension for now
            if (name.slice(-4) != '.csv') return reply(boom.badRequest('.csv files only'));
            if (path[path.length - 1] !== '/') path = path + '/';
            var file = fs.createWriteStream(path + name);

            file.on('error', function(err) {
                reply(boom.badRequest(err));
            });

            data.file.pipe(file);

            data.file.on('end', function(err) {
                reformatCsv(path, path + name, function(err, filename) {
                    if (err) {
                        fs.unlink(path + name, function() {
                            reply(boom.badRequest(err));
                        });
                    } else {
                        var closed = 0;

                        client.query('CREATE TABLE temp_' + taskName + ' (key VARCHAR(255), value TEXT);', function(err, results) {
                            if (err) {
                                console.log('create temp');
                                return reply(boom.badRequest(err));
                            }
                        });

                        var stream = client.query(pg_copy.from('COPY temp_' + taskName + ' FROM STDIN (FORMAT CSV);'));
                        var fileStream = fs.createReadStream(filename, {
                            encoding: 'utf8'
                        });

                        // csv errors aren't being caught and surfaced very well, silent

                        fileStream
                            .on('error', function(err) {
                                console.log('err here', err);
                                return reply(boom.badRequest(err));
                            })
                            .pipe(stream)
                            .on('finish', theEnd)
                            .on('error', theEnd);

                        // do this because on error both will emit something and calling reply twice errors
                        function theEnd(err) {
                            if (err) {
                                closed = 1;
                                return closed ? null : reply(boom.badRequest(err));
                            }
                            setTimeout(function() {
                                queue(1)
                                    .defer(function(cb) {
                                        var query = 'ALTER TABLE temp_' + taskName + ' ADD COLUMN time INT DEFAULT 0;';

                                        client.query(query, cb);
                                    })
                                    .defer(function(cb) {
                                        var order = ' ORDER BY RANDOM();';
                                        if (data.preserve) order = ';';
                                        var query = 'CREATE TABLE ' + taskName + ' as SELECT * FROM temp_' + taskName + order;
                                        client.query(query, cb);
                                    })
                                    .defer(function(cb) {
                                        var query = 'CREATE INDEX CONCURRENTLY ON ' + taskName + ' (time);';
                                        client.query(query, cb);
                                    })
                                    .defer(function(cb) {
                                        var query = 'CREATE TABLE ' + taskName + '_stats (time INT, attributes HSTORE);';
                                        client.query(query, cb);
                                    })
                                    .defer(function(cb) {
                                        var query = 'CREATE INDEX CONCURRENTLY ON ' + taskName + '_stats (time);';
                                        client.query(query, cb);
                                    }).defer(function(cb) {
                                        var query = queries.create_type();
                                        client.query(query, cb);
                                    }).defer(function(cb) {
                                        var query = queries.create_function(taskName);
                                        client.query(query, cb);
                                    })
                                    .defer(function(cb) {
                                        var query = 'DROP TABLE temp_' + taskName + ';';
                                        client.query(query, cb);
                                    })
                                    .defer(function(cb) { //Lets avoid create tables out off this file
                                        var query = queries.create_task_details();
                                        client.query(query, cb);
                                    })
                                    .defer(function(cb) {
                                        var details = [];
                                        details.push(data.id);
                                        details.push(data.name);
                                        details.push(data.source);
                                        details.push(data.owner);
                                        details.push(data.description);
                                        details.push(Math.round(+new Date() / 1000));
                                        details.push(true) //status =true, for a new task
                                        client.query('INSERT INTO task_details VALUES($1, $2, $3, $4, $5, $6, $7);', details, cb);
                                    })
                                    .awaitAll(function(err, results) {
                                        if (err) return reply(boom.badRequest(err));
                                        return reply(JSON.stringify({
                                            taskname: taskName
                                        }));
                                    });
                            }, 500);
                        }

                    }
                });
            });

        }
    }
});

pg.connect(conString, function(err, c, d) {
    if (err) return console.log(err);
    console.log('connected to:', address);
    client = c;
    done = d;
    server.start(function() {
        console.log('server on port', port);
    });
});