/* Magic Mirror - WallberryTheme <3
 * Module: WB-weather
 *
 * By JSC (@delightedCrow)
 * MIT Licensed.
 */
Module.register("WB-weather", {
	// Module config defaults.
	defaults: {
		providerName: "openweathermap",
		template: "classic-wallberry",

		apiKey: null, // REQUIRED
		latitude: null, // REQUIRED
		longitude: null, // REQUIRED

		units: config.units, // "standard", "metric", "imperial"
		language: config.language, // what language to localize for
		daysToForecast: 4, // how many days to include in upcoming forecast (including today)

		updateInterval: 30 * 60 * 1000, // Refresh at most every 30 minutes by default
		initialLoadDelay: 1000
	},

	fetchTimer: null,
	nextFetchAt: null, // Absolute deadline preserved while hidden
	fetchInProgress: false,
	suspended: false,
	provider: null,
	weather: null,
	error: null,

	getTranslations: function() {
		return {
			en: "translations/en.json"
		};
	},

	getScripts: function() {
		let provider = this.hasPre3Config() ? "darksky" : this.config.providerName;
		return [
			"moment.js",
			"WB-dataObjects.js",
			"WB-provider.js",
			this.file("providers/WB-" + provider + ".js")
		];
	},

	getStyles: function() {
		return [
			"weather-icons.css",
			this.file("css/" + this.config.template + ".css")
		];
	},

	getTemplate: function() {
		return `templates/${this.config.template}.njk`;
	},

	getTemplateData: function() {
		return {
			weather: this.weather,
			error: this.error
		};
	},

	start: function() {
		Log.info(`Starting module: ${this.name}`);
		// lower case helps eliminate user error in writing config options
		this.config.providerName = this.config.providerName.toLowerCase();
		this.config.template = this.config.template.toLowerCase();

		this.addNunjuckFilters();

		if (this.hasPre3Config()) {
			// make the update a little smoother for the people who updated from a pre-3.0 version of WB-weather and are still using darksky
			this.config.providerName = "darksky";
			this.config.apiKey = this.config.darkSkyApiKey;
		}
		this.provider = WBProviderManager.initialize(this.config, this);
		if (this.provider == null) {
			let message = `Cannot find a weather provider named "${this.config.providerName}". Please check your config settings.`
			this.error = new WBError(false, message);
			Log.error(message);
		} else {
			this.scheduleUpdate(this.config.initialLoadDelay);
		}
	},

	suspend: function() {
		Log.debug(`Suspending module: ${this.name}`);
		this.suspended = true;
		clearTimeout(this.fetchTimer);
		this.fetchTimer = null;
		// Keep nextFetchAt and the current weather data for the next page visit.
	},

	resume: function() {
		Log.debug(`Resuming module: ${this.name}`);
		this.suspended = false;

		// A request started on the previous page may still be in flight.
		// Its response will schedule the next refresh.
		if (this.provider === null || this.fetchInProgress) {
			return;
		}

		// Do not retry permanent provider errors on every page change.
		if (this.provider.error !== null && !this.provider.error.isTemporary) {
			return;
		}

		const remaining = this.nextFetchAt === null
			? this.config.initialLoadDelay
			: Math.max(0, this.nextFetchAt - Date.now());
		this.scheduleUpdate(remaining);
	},

	// gets called by the weather provider when it has an update available
	updateAvailable: function() {
		// Only schedule another fetch if we succeeded in getting the weather or if the error we encountered is temporary
		this.fetchInProgress = false;

		if (this.provider.error === null) {
			// Keep the successful response in memory until the next refresh.
			this.scheduleUpdate(this.provider.updateInterval);
		} else if (this.provider.error.isTemporary) {
			// Retry temporary errors, but never more frequently than updateInterval.
			this.scheduleUpdate(Math.max(this.provider.updateInterval, this.provider.error.retryDelay || 0));
		} else {
			// A permanent error must not trigger a fetch when the page reappears.
			this.nextFetchAt = null;
			clearTimeout(this.fetchTimer);
			this.fetchTimer = null;
		}

		// we should update the dom with the new update
		this.weather = this.provider.weather;
		this.error = this.provider.error;
		this.updateDom();
	},

	scheduleUpdate: function(delay=null) {
		let nextFetch = this.provider.updateInterval;
		if (delay !== null && delay >= 0) {
			nextFetch = delay;
		}

		// Save an absolute deadline so a page change cannot reset the interval.
		this.nextFetchAt = Date.now() + nextFetch;
		clearTimeout(this.fetchTimer);
		this.fetchTimer = null;

		// The next page visit will use the remaining delay.
		if (this.suspended || this.fetchInProgress) {
			return;
		}

		this.fetchTimer = setTimeout(() => {
			this.fetchTimer = null;
			if (this.suspended || this.fetchInProgress) {
				return;
			}

			this.nextFetchAt = null;
			this.fetchInProgress = true;
			Log.info(`WB-weather: fetching weather via ${this.provider.name}`);

			try {
				if (this.provider.usesNodeHelper) {
					this.sendSocketNotification("FETCH_DATA", {providerName: this.provider.name, data: this.provider.dataForHelper()});
				} else {
					this.provider.fetchWeather();
				}
			} catch (error) {
				this.fetchInProgress = false;
				this.provider.resolveWithTemporaryError(error.message);
			}
		}, nextFetch);
	},

	socketNotificationReceived: function(notification, payload) {
		switch(notification) {
			case "DATA_AVAILABLE":
				// TODO: check if this helper response is for this instance of WB-weather - pretty sure we can have multiple WB-weather instances but only one node_helper for all them.
				this.provider.helperResponse(payload);
				break;
		}
	},

	hasPre3Config: function() {
		// back before 3.0 DarkSky was the default provider and the
		// config option for its api key was darkSkyApiKey
		if (this.config.apiKey == null && this.config.darkSkyApiKey !==null) {
			return true;
		}
		return false;
	},

	nunjucksEnvironment: function() {
		if (this._nunjucksEnvironment !== null) {
			return this._nunjucksEnvironment;
		}

		this._nunjucksEnvironment = new nunjucks.Environment(new nunjucks.WebLoader(this.file(""), {async: true, useCache: true}), {
			trimBlocks: true,
			lstripBlocks: true
		});

		return this._nunjucksEnvironment;
	},

	addNunjuckFilters: function() {
		this.nunjucksEnvironment().addFilter("dayLabel", function(timestamp) {
			var date = new Date(timestamp * 1000);
			return moment.weekdaysShort(date.getDay());
		});

		this.nunjucksEnvironment().addFilter("precipIcons", function(precipType) {
			return this.precipitationTypes[precipType];
		}.bind(this));

		this.nunjucksEnvironment().addFilter("translate", function(str, variables) {
			return this.translate(str, variables);
		}.bind(this));
	},

	// wi names for main precipitation types.
	precipitationTypes: {
		"snow": "wi-snowflake-cold",
		"rain": "wi-raindrop"
	},
});
