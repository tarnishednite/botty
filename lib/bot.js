var _ = require('underscore'),
	fast_bindall = require(process.env.SRCTOP + '/ec/lib/util/fast_bindall'),
	id_utilities = require(process.env.SRCTOP + '/ec/lib/util/id_utilities').ID_Utilities,
	type_ids = require(process.env.SRCTOP + '/ec/lib/util/type_ids').Type_IDs,
	date_util = require(process.env.SRCTOP + '/ec/lib/util/date_utilities').Date_Utilities,
	async = require('async'),
	socket_client = require('socket.io-client'),
	https = require('https');

var Bot = function(options) {
	_.extend(this, options);
	fast_bindall(this);
	this.scoreboard_url = 'https://' + this.host + ':' + this.port;
	this.request_callbacks = {};
	this.request_count = 1;
};

_.extend(Bot.prototype, {
	start: function() {
		async.series([
			this.get_scoreboard,
			this.init_socket,
			this.signin,
			this.get_initial_data,
			this.init_socket
		], this.handle_error);
	},
	get_scoreboard: function(callback) {
		var self = this;
		https.get(this.scoreboard_url, function(response) {
			var data = '';
			response.on('data', function(chunk) {
				data += chunk;
			});
			response.on('end', function() {
				var match = data.match(/\"scoreboard\":.*?\"(.*?):/);
				console.warn("GOT SCOREBOARD:", match[1]);
				self.sexio_host = hostname = match[1];
				return process.nextTick(callback);
			});
		});
	},
	init_socket: function(callback) {
		console.warn("INIT SOCKET:", this.sexio_host, this.port);
		this.socket = socket_client.connect('https://' + this.sexio_host + ':' +  this.port, {
			extraHeaders: {
				Cookie: this.cookie
			}
		});
		console.warn("SOCKET CREATED");
		this.socket.once('connect', callback);
		this.socket.on('event', this.handle_event);
		this.socket.on('message', this.handle_message);
		this.socket.on('response', this.handle_response);
		this.socket.on('disconnect', this.handle_disconnect);
		this.socket.on('error', this.handle_error);
	},
	handle_error: function(error) {
		if (error) {
			console.warn("ERROR:", error);
		}
	},
	signin: function(callback) {
		console.warn("REQUESTING SIGNIN");
		var self = this;
		this.request(
			'/api/login', 
			'PUT',
			{
				email: this.user,
				password: this.password,
				rememberme: true,
				_csrf: null
			},
			function(error, data) {
				if (error) { return callback(data); }
				console.warn(data);
				self.auth = data['X-Authorization'];
				self.cookie = data.set_cookie.map(function(cookie) {
					var parts = cookie.split(/\;/);
					return parts[0];
				}).join("; ");
				console.warn(self.cookie);
				return process.nextTick(callback);
			}
		);
	},
	request: function(uri, method, params, callback) {
		params.request_id = this.request_count;
		this.request_callbacks[this.request_count] = callback;
		this.request_count++;
		this.socket.emit(
			'request', 
			{ 
				uri: uri, 
				parameters: params,
				method: method
			}
		);
	},
	handle_response: function(data) {
		if (
			data && 
			data.request && 
			data.request.parameters &&	
			data.request.parameters.request_id 
		) {
			var request_id = data.request.parameters.request_id;
			if (this.request_callbacks[request_id]) {
				return this.request_callbacks[request_id](null, data);
			}			
		}
	},
	handle_event: function(event) {
	},
	handle_message: function(message_raw) {
		var message;
		try {
			message = JSON.parse(message_raw);
		} catch(error) {
			console.warn(error);
		}
		console.warn(message);
		if (!message.body || !message.body.objects) { return; }
		async.forEach(message.body.objects, this.process_object_group, this.handle_error);
	},
	process_object_group: function(object_group, callback) {
		async.forEach(object_group, this.process_object, callback);
	},
	process_object: function(object, callback) {
		var id = object._id;
		var type = id_utilities.prototype.extract_type(id);
		if (type === type_ids.TYPE_ID_POST) {
			this.handle_post(object);
		}
		return process.nextTick(callback);
	},
	handle_post: function(post) {
		if (!post.is_new || !post.text) { return; }
		if (post.is_new && post.text.match(/^\!howmanydays/i)) {
			this.post_days(post.group_id);
		}
		if (post.is_new && post.text.match(/^\!killmenow/i)) {
			this.post(post.group_id, ":dizzy_face::gun:");
		}
		if (post.is_new && post.text.match(/^\!metadata/i)) {
			this.post(post.group_id, _.times(Math.floor(Math.random() * 100), function() { return ":metadata:" }).join(''));
		}
	},
	post: function(group_id, text) {
		this.request(
			'/api/post',
			'POST',
			{
				created_at: +new Date(),
				creator_id: this.user_id,
				is_new: true,
				item_ids: [],
				group_id: group_id,
				text: text
			},
			function(error, data) {
				console.warn(error, data);
			}
		);
	},
	post_days: function(group_id) {
		var target = new Date(2017, 5, 3);
		var now = new Date();
		var diff = target - now;
		var days = Math.floor(diff / (24*60*60*1000));
		diff -= (days * 24*60*60*1000);
		var hrs = Math.floor(diff / (60*60*1000));
		diff -= (hrs * 60*60*1000);
		var mins = Math.floor(diff / (60*1000));
		diff -= (mins * 60*1000);
		var secs = Math.floor(diff / 1000);
		diff -= (secs * 1000);
		var ms = diff;
		var remaining = [days, " day(s) ", hrs, ":", mins, ":", secs + '.' + ms].join(''); 
		this.post(group_id, 'Days remaining in RingCentral Contract: ' + remaining);
	},
	handle_disconnect: function(reason) {
	},
	get_initial_data: function(callback) {
		var self = this;
		this.request(
			'/api/index',
			'GET',
			{},
			function(error, pack) {
				var data = pack.body;
				self.user_id = data.user_id;
				var parts = data.scoreboard.split(/\:/);
				console.warn("UID:", self.user_id);
				self.sexio_host = parts[0];
				self.port = parts[1];
				self.initial_data = data;
				self.socket.close();
				return process.nextTick(callback);
			}
		);
	}
});

module.exports = Bot;
