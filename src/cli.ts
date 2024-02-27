import { Command, Option, type OptionValues } from 'commander';
import { statSync } from 'node:fs';
import pino, { type Logger } from 'pino';
import 'dotenv/config';
import { Config } from './types';
import p from '../package.json' with { type: 'json' };

export const program = new Command();
const L = pino();
const bads = ['⛔', '💩', '🥶', '💣'];
const bad = bads[Math.floor(Math.random() * bads.length)];

const data = {
	name: p.name,
	description: p.description,
	version: p.version
};

program
	.name(data.name)
	.description(data.description)
	.addOption(
		new Option('-z, --zencode-directory <directory>', 'specify the zencode contracts directory')
			.env('ZENCODE_DIR')
			.default('./', 'current directory')
			.argParser((d) => {
				try {
					if (statSync(d).isDirectory()) return d;
				} catch (e) {
					L.error(`${bad} ${d} is not a valid directory`);
					process.exit(0);
				}
			})
	)
	.addOption(
		new Option('--public-directory <directory>', 'specify the static files directory')
			.env('PUBLIC_DIR')
			.argParser((d) => {
				try {
					if (statSync(d).isDirectory()) return d;
				} catch (e) {
					L.error(`${bad} ${d} is not a valid directory`);
					process.exit(0);
				}
			})
	)
	.addOption(
		new Option(
			'-p, --port <number>',
			'specify port number; if unspecified restroom will listen to a random free port'
		)
			.env('PORT')
			.default(0)
			.argParser((c) => parseInt(c))
	)
	.addOption(
		new Option(
			'--zenroom-version <string>',
			'specify the version of ZENROOM to interpret the contracts'
		)
			.env('ZENROOM_VERSION')
			.default('4.12.0')
	)
	.addOption(
		new Option('--openapi-path <string>', 'specify where to mount the swagger docs')
			.env('OPENAPI_PATH')
			.default('/docs')
	)
	.addOption(
		new Option('--hostname <string>', 'Provide the hostname to serve the server')
			.env('HOSTNAME')
			.default('0.0.0.0')
	)
	.addOption(
		new Option('--template <file>', 'Provide the html template for the applets').default(
			'./applet_template.html'
		)
	)
	.addOption(new Option('-D, --debug', 'debug').env('DEBUG').default(false).argParser(Boolean))
	.version(data.version, '-v, --version')
	.addHelpText(
		'after',
		`
Examples:
  # Serve zencode files on the current directory over a random port
  $ ncr

  # Serve all zencode files on ./contracts over 3000 port
  $ ncr -z contracts -p 3000`
	)
	.parse();

export const config: Config = {
	...program.opts(),
	logger: L
};
