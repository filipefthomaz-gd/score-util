#!/usr/bin/env node

import module from 'module';
import util from 'util';
import chalk from 'chalk';
import createVideo from '../lib/create-video.js';
import modifyScore from '../lib/modify-score.js';
import { parseChannels, scoreMedia, tmpfile } from '../lib/utils.js';
import createAudio from '../lib/create-audio.js';

function getArgs() {
	try {
		return util.parseArgs({
			allowPositionals: true,
			options: {
				audio: {
					type: 'boolean',
					default: false
				},
				'audio-channels': {
					type: 'string'
				},
				'audio-output': {
					type: 'string'
				},
				'audio-offset': {
					type: 'string',
					default: '0'
				},
				ffmpeg: {
					type: 'string',
					default: 'ffmpeg'
				},
				'dual-page': {
					type: 'boolean',
					default: false
				},
				'top-offset': {
					type: 'string',
					default: '0'
				},
				end: {
					type: 'string'
				},
				fps: {
					type: 'string',
					default: '60'
				},
				help: {
					type: 'boolean',
					short: 'h'
				},
				mscore: {
					type: 'string',
					default: 'mscore'
				},
				start: {
					type: 'string'
				},
				version: {
					type: 'boolean',
					short: 'v'
				},
				width: {
					type: 'string'
				}
			}
		});
	} catch (/** @type {any} */e) {
		console.error(e.message);

		process.exit(1);
	}
}

function getVersion() {
	const require = module.createRequire(import.meta.url);

	return require('../package.json').version;
}

const args = getArgs();

if (args.values.version) {
	console.log(getVersion());

	process.exit(0);
}

if (args.values.help || args.positionals.length !== 2) {
	console.log(`Usage: create-musescore-video [options] input.mscz output.mp4

Options:
 -h,--help                show help text
 -v,--version             show version
 --ffmpeg=FILE            path to ffmpeg executable
 --mscore=FILE            path to MuseScore (mscore) executable
 --audio                  include audio in the video (default mix)
 --audio-channels=SPEC    per-channel volumes: 'track1=volume1,track2=volume2...' (implies --audio)
 --audio-output=FILE      save exported audio to FILE (e.g. output.wav) (implies --audio)
 --audio-offset=MS        shift audio earlier by MS milliseconds (e.g. --audio-offset=40)
 --fps=NUMBER             frames per second (default: 60)
 --width=NUMBER           output width in pixels, height auto-scaled
 --start=SECONDS          start time in seconds (e.g. --start=30)
 --end=SECONDS            end time in seconds (e.g. --end=90)
 --dual-page              show current page and next page side by side
 --top-offset=N           shift vertical crop by N SVG units (positive=down, negative=up/show title)
`);

	process.exit(args.values.help ? 0 : 1);
}

/** @type {Record<string, number> | undefined} */
let audioChannels;

if (args.values['audio-channels'] != null) {
	const channels = parseChannels(args.values['audio-channels']);

	if (channels.every(channel => channel != null)) {
		audioChannels = Object.fromEntries(channels);
	} else {
		console.error('Invalid audio-channels specifier: ', args.values['audio-channels']);

		process.exit(1);
	}
}

const includeAudio = args.values.audio || audioChannels != null || args.values['audio-output'] != null;

const [musescoreFile, videoFile] = args.positionals;

console.log('Reconfiguring score %s for export', chalk.bold(musescoreFile));

const temporaryPrefix = await tmpfile();
const temporaryScoreFile = `${temporaryPrefix}.mscz`;

await modifyScore(musescoreFile, temporaryScoreFile, audioChannels ?? {}, { dualPage: args.values['dual-page'] });

console.log('Loading score media for %s', chalk.bold(temporaryScoreFile));

const audioOutputFile = args.values['audio-output'] ?? (includeAudio ? `${temporaryPrefix}.wav` : undefined);

const [mediaInfo, audioFile] = await Promise.all([
	scoreMedia(temporaryScoreFile, { mscore: args.values.mscore }),
	audioOutputFile != null ? createAudio(temporaryScoreFile, audioOutputFile, { mscore: args.values.mscore }) : undefined
]);

console.log('Creating video %s', chalk.bold(videoFile));

await createVideo(mediaInfo, audioFile, videoFile, {
	ffmpeg: args.values.ffmpeg,
	fps: Number(args.values.fps),
	width: args.values.width != null ? Number(args.values.width) : undefined,
	startMs: args.values.start != null ? Number(args.values.start) * 1000 : undefined,
	endMs: args.values.end != null ? Number(args.values.end) * 1000 : undefined,
	dualPage: args.values['dual-page'],
	topOffset: Number(args.values['top-offset']),
	audioOffsetMs: Number(args.values['audio-offset'])
});
