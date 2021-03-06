const fs = require("fs");
const path = require("path");
const Ajv = require("ajv");
const axios = require("axios");
const Fastify = require("fastify");
const recursive = require("fs-readdir-recursive");

const RegistryClient = require("./RegistryClient");

class InvalidConfigException extends Error {
    constructor(message) {
        super(message);
        this.name = "InvalidConfigException";
    }
}

/** Class respesenting a service */
class Service {

    /**
     * Service configuration object.
     */
    config = null;

    /**
     * Fastify server object.
     */
    app = null;

    /**
     * JSON schema validator.
     */
    schemaValidator = new Ajv({ allErrors: true });

    /**
     * Client for communicating with registry service
     */
    registryClient = null;

    /**
     * Loads schema files from schemasFolderPath and adds them to validator.
     * All schema files must have ".schema.json" extensions.
     * @param {string} schemasFolderPath 
     */
    loadValidationSchemas(schemasFolderPath = path.join(__dirname, "schemas")) {
        const files = recursive(schemasFolderPath);

        files.forEach((file) => {
            console.log(file)
            if (!file.endsWith(".schema.json")) return;

            const fullPath = path.join(schemasFolderPath, file);
            const schema = require(fullPath);

            this.schemaValidator.addSchema(schema, schema.name);
            // TODO: Find a way to set fastify's ajv object
            // this.app.addSchema(schema, schema.name);
        });
    }

    /**
     * Registers a service in registry service specified in config file.
     * If config["self-register"] is true, will be executed on service initialization.
     * 
     * Not recommended to use besides internal use.
     */
    async register() {
        if (!this.config.services["registry-service"]) {
            this.app.log.warn("Service tried to register, but registry server is not specified in config file");
            return;
        }
        try {
            const r = await axios({
                method: "post",
                baseURL: `http://${this.config.services["registry-service"].hostname}:${this.config.services["registry-service"].port}`,
                url: "/v1/catalog/register",
                timeout: 1000,
                validateStatus: (status) => { return status >= 200 && status <= 304; },
                data: {
                    guid: this.config.guid,
                    name: this.config.name,
                    version: this.config.version,
                    prefix: this.config.prefix,
                    port: this.config.port,
                    hostname: this.config.hostname || "localhost"
                }
            });

            this.app.log.info("Service is registered");
        } catch (e) {
            if (e.response) {
                if (e.response.status >= 400) {
                    this.app.log.warn({ data: e.response.data }, `Failed to register service (${e.response.status}).`)
                    return;
                }
            } else if (e.request) {
                if (e.errno == "ECONNREFUSED") {
                    console.log(e);
                    this.app.log.warn("Failed to register service (is registry service up?). Retrying after 10 seconds...");
                    setTimeout(async () => this.register(), 10000);
                    return;
                }
            } else {
                this.app.log.warn("Failed to register service (unknown error).");
                //this.app.log.error(e);
                console.log(e);
                return;
            }
        }
    }

    /**
     * Validates config object with internal scheme.
     * For internal use only.
     * @param {object} config 
     */
    validateConfiguration(config) {
        return this.schemaValidator.validate("serviceConfigSchema", config);
    }

    /**
     * Loads config file from disk.
     * Not recommended to use.
     * @param {string} configFilePath - config file path
     * @param {string} configFormat - config file format (default: json)
     */
    loadConfigFromFile(configFilePath, configFormat = "json") {
        let config = {};

        if (configFormat == "json") {
            let configBuffer = fs.readFileSync(configFilePath, { encoding: "utf-8" }).toString();
            config = JSON.parse(configBuffer);
        }

        const configValid = this.validateConfiguration(config);
        if (!configValid)
            return null;

        return config;
    }

    /**
     * Initializes http server.
     * For internal use only.
     */
    initHttpServer() {
        this.app = Fastify(Object.assign(this.config.settings.fastify || {}, { prefix: this.config.prefix }));
    }

    /**
     * Starts listeting on port specified in config file.
     */
    listen() {
        this.app.listen(this.config.port);
    }

    /**
     * This method registers controllers from controllerDirPath.
     * All controllers in a directory must have ".controller.js" extension.
     * These controller files use fastify route syntax.
     * 
     * @example
     * {
     *  method: "GET",
     *  url: "/",
     *  handler: (req, res) => {
     *    res.send("ok");
     *  }
     * }
     * 
     * @param {string} controllerDirPath - controllers directory path
     * @param {boolean} registerDefaultRoutes - if true, registers default root controller for health check
     * 
     * @throws {Error}
     */
    registerControllers(controllerDirPath = path.join(__dirname, "controllers"), registerDefaultRoutes = true) {
        const files = recursive(controllerDirPath);

        files.forEach((file) => {
            if (!file.endsWith(".controller.js")) return;
            // Don't register default route if regsiterDefaultRoutes is false
            if (file.endsWith(".default.controller.js") && !registerDefaultRoutes) return;

            console.log(file);

            const appMiddleware = (req, res, done) => {
                req.app = this;
                done();
            }

            const route = (fastify, opts, next) => {
                const controllers = require(path.join(controllerDirPath, file));

                for (const c of controllers) {
                    fastify.route(Object.assign({ preHandler: appMiddleware }, c));
                }

                next();
            };

            this.app.register(route, { prefix: this.config.prefix })
        });
    }

    /**
     * Creates a new service.
     * Loads configuration file from config. If config is a string, it will treat it as a path. 
     * @param {string | object} config - config file path or object
     * @param {string} configFormat - config format (for now only json is supported)
     */
    constructor(config, configFormat = "json") {

        this.loadValidationSchemas();

        if (typeof config == "string")
            this.config = this.loadConfigFromFile(config, configFormat);
        else this.config = config;
        
        if (!this.config) {
            throw new InvalidConfigException("Configuration file is invalid or doesn't exist");
        }

        this.initHttpServer();
        this.registerControllers(path.join(__dirname, "controllers"), this.config.registerDefaultRoutes);

        if (this.config["self-registry"])
            this.register();

        let registryServices = this.config.services.filter(value => value.type == "registry");

        if (registryServices.length != 0) {
            registryServices = registryServices.sort((a, b) => {
                return b.priority - a.priority;
            });

            this.registryClient = new RegistryClient(registryServices[0].hostname, registryServices[0].port);
        }
    }

}

exports.Service = Service;