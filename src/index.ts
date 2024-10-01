// SPDX-FileCopyrightText: 2024 The Forkbomb Company
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import dotenv from 'dotenv';
import fs from 'fs';
import mime from 'mime';
import path from 'path';
import {
	TemplatedApp,
	us_socket_local_port,
	LIBUS_LISTEN_EXCLUSIVE_PORT
} from 'uWebSockets.js';
import { autorunContracts } from './autorun.js';
import { config } from './cli.js';
import { Directory } from './directory.js';
import {
	defaultTags,
	defaultTagsName,
	definition,
	generateAppletPath,
	generatePath,
	generateRawPath,
	openapiTemplate
} from './openapi.js';
import { SlangroomManager } from './slangroom.js';
import { formatContract } from './fileUtils.js';
import { getSchema, getQueryParams, prettyChain, newMetadata } from './utils.js';
import { forbidden, notFound, unprocessableEntity, internalServerError } from './responseUtils.js';
import { createAppWithBasePath, generateRoute, runPrecondition } from './routeUtils.js';

dotenv.config();

const L = config.logger;
const Dir = Directory.getInstance();

const PROM = process.env.PROM == 'true';

if (typeof process.env.FILES_DIR == 'undefined') {
	process.env.FILES_DIR = config.zencodeDir;
}

const setupProm = async (app: TemplatedApp) => {
	const client = await import('prom-client');
	const register = new client.Registry();
	register.setDefaultLabels({
		app: 'ncr'
	});
	client.collectDefaultMetrics({ register });

	const co2lib = await import('@tgwf/co2');
	const swd = new co2lib.co2({ model: 'swd' });

	const co2_emission = new client.Gauge({
		name: 'co2_emission',
		help: 'Emissions for 1GB',
		collect() {
			const emissions = swd.perByte(1000000000);
			this.set(emissions);
		}
	});

	register.registerMetric(co2_emission);

	app.get('/metrics', (res) => {
		register
			.metrics()
			.then((metrics) =>
				res.writeStatus('200 OK').writeHeader('Content-Type', register.contentType).end(metrics)
			);
	});
};

const ncrApp = async () => {
	const app = createAppWithBasePath(config.basepath)
		.get('/', (res, req) => {
			const files = Dir.files.reduce((acc, f) => {
				const { path, metadata } = f;
				if (!metadata.hidden && !metadata.hideFromOpenapi)
					acc.push(`http://${req.getHeader('host')}${config.basepath}${path}`);
				return acc;
			}, []);
			res
				.writeStatus('200 OK')
				.writeHeader('Content-Type', 'application/json')
				.end(JSON.stringify(files));
		})
		.get(config.openapiPath, (res) => {
			res.writeStatus('200 OK').writeHeader('Content-Type', 'text/html').end(openapiTemplate);
		})
		.get('/oas.json', async (res) => {
			definition.paths = {};
			const tags = [];
			await Promise.all(
				Dir.files.map(async (endpoints) => {
					const { path, metadata } = endpoints;
					if (metadata.tags) tags.push(...metadata.tags);					
          if (definition.paths && !metadata.hidden && !metadata.hideFromOpenapi) {
            const prefixedPath = config.basepath + path;
						const schema = await getSchema(endpoints);
						if (schema)
							definition.paths[prefixedPath] = generatePath(
								endpoints.contract ?? prettyChain(endpoints.chain),
								schema,
								metadata
							);
						definition.paths[prefixedPath + '/raw'] = generateRawPath();
						definition.paths[prefixedPath + '/app'] = generateAppletPath();
					}
				})
			);
			const customTags = tags.reduce((acc, tag) => {
				if (tag === defaultTagsName.zen) return acc;
				const t = { name: tag };
				if (!acc.includes(t)) acc.push(t);
				return acc;
			}, []);
			definition.tags = [...customTags, ...defaultTags];
			res.cork(() => {
				res
					.writeStatus('200 OK')
					.writeHeader('Content-Type', 'application/json')
					.end(JSON.stringify(definition));
			});
		})
		.get('/health', async (res) => {
			res.onAborted(() => {
				res.writeStatus('500').writeHeader('Content-Type', 'application/json').end('Aborted');
			});
			const s = SlangroomManager.getInstance();
			const contract = `
Rule unknown ignore
Given I connect to 'hi_endpoint' and do get and output into 'hi_result'
Given I have a 'string' named 'result' in 'hi result'
Then print the 'result'
`;
			const keys = {
				hi_endpoint: `http://${config.hostname}:${config.port}${config.basepath}/sayhi`
			};
			try {
				const { result } = await s.execute(contract, { keys });
				res.cork(() => {
					res
						.writeStatus('200 OK')
						.writeHeader('Content-Type', 'application/json')
						.end(JSON.stringify(result));
				});
			} catch (e) {
				internalServerError(res, L, e as Error);
			}
		})
		.get('/sayhi', (res) => {
			res.writeStatus('200 OK').writeHeader('Content-Type', 'text/plain').end('Hi');
		});

	if (PROM) {
		await setupProm(app);
	}
	return app;
};

const generatePublicDirectory = (app: TemplatedApp) => {
	const { publicDirectory, basepath } = config;
	if (publicDirectory) {
		app.get('/*', async (res, req) => {
			res.onAborted(() => {
				res.writeStatus('500').end('Aborted');
			});
			let url = req.getUrl();
			if (url.split('/').pop().startsWith('.')) {
				notFound(res, L, new Error('Try to access hidden file'));
				return;
			}
			//remove basepath from the beginning of the url if it is present
			if (basepath !== '' && url.startsWith(basepath)) {
				const re = new RegExp(`^${basepath}`);
				url = url.replace(re, '');
			}
			const file = path.join(publicDirectory, url);
			if (fs.existsSync(file) && fs.statSync(file).isFile()) {
				let contentType = mime.getType(file) || 'application/json';
				if (fs.existsSync(file + '.metadata.json')) {
					let publicMetadata;
					try {
						publicMetadata = JSON.parse(fs.readFileSync(file + '.metadata.json'));
					} catch (e) {
						unprocessableEntity(
							res,
							L,
							new Error(`Malformed metadata file: ${(e as Error).message}`)
						);
						return;
					}
					if (publicMetadata.contentType) contentType = publicMetadata.contentType;
					if (publicMetadata.precondition) {
						try {
							const data: Record<string, unknown> = getQueryParams(req);
							await runPrecondition(path.join(publicDirectory, publicMetadata.precondition), data);
						} catch (e) {
							forbidden(res, L, e as Error);
							return;
						}
					}
				}
				res.cork(() => {
					res
						.writeStatus('200 OK')
						.writeHeader('Access-Control-Allow-Origin', '*')
						.writeHeader('Content-Type', contentType)
						.end(fs.readFileSync(file));
				});
			} else {
				notFound(res, L, new Error(`File not found: ${file}`));
			}
		});
	}
};

const generateEndpoint = (basePath: string): Endpoints | undefined => {
	if (Dir.getContent(basePath + '.zen') !== undefined) {
		return {
			path: basePath,
			contract: formatContract(Dir.getContent(basePath + '.zen')),
			keys: Dir.getJSON(basePath, 'keys'),
			conf: Dir.getContent(basePath + '.conf') || '',
			schema: Dir.getJSONSchema(basePath),
			metadata: newMetadata(Dir.getJSON(basePath, 'metadata') || {})
		};
	} else if (Dir.getContent(basePath + '.chain.js') !== undefined) {
		return {
			path: basePath,
			chain: Dir.getContent(basePath + '.chain.js'),
			schema: Dir.getJSONSchema(basePath),
			metadata: newMetadata(Dir.getJSON(basePath, 'metadata') || {})
		};
	}
	return;
};

Dir.ready(async () => {
	const app = await ncrApp();

	await autorunContracts();

	await Promise.all(
		Dir.files.map(async (endpoint) => {
			await generateRoute(app, endpoint, 'add');
		})
	);

	generatePublicDirectory(app);

	app.listen(config.port, LIBUS_LISTEN_EXCLUSIVE_PORT, (socket) => {
		if (socket) {
			const port = us_socket_local_port(socket);
			L.info(`Swagger UI is running on http://${config.hostname}:${port}${config.basepath}${config.openapiPath}`);
		} else {
			L.error('Port already in use ' + config.port);
			throw new Error('Port already in use ' + config.port);
		}
	});

	Dir.onAdd(async (path: string) => {
		const [baseName, ext, json] = path.split('.');
		const endpoint = generateEndpoint(baseName);
		if (!endpoint) return;
		let event: string;
		if (ext === 'zen' || (ext === 'chain' && json === 'js')) {
			event = 'add';
		} else {
			event = 'update';
		}
		await generateRoute(app, endpoint, event);
	});

	Dir.onUpdate(async (path: string) => {
		const endpoint = generateEndpoint(path.split('.')[0]);
		if (!endpoint) return;
		await generateRoute(app, endpoint, 'update');
	});

	Dir.onDelete(async (path: string) => {
		const [baseName, ext, json] = path.split('.');
		let endpoint: Endpoints;
		let event: string;
		if (ext === 'zen' || (ext === 'chain' && json === 'js')) {
			endpoint = {
				path: baseName,
				contract: null,
				chain: null,
				conf: '',
				metadata: {}
			};
			event = 'delete';
		} else {
			endpoint = generateEndpoint(baseName);
			event = 'update';
		}
		if (!endpoint) return;
		await generateRoute(app, endpoint, event);
	});
});
