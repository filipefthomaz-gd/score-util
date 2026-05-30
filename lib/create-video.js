import assert from 'assert';
import { spawn } from 'child_process';
import chalk from 'chalk';
import * as xml from 'fast-xml-parser';
import { Resvg } from '@resvg/resvg-js';

/**
 * @param {import('./types.js').ScoreMedia} mediaInfo
 * @param {string | undefined} audioFile
 * @param {string} videoFile
 * @param {{
 *   ffmpeg?: string | undefined,
 *   fps?: number | undefined,
 *   width?: number | undefined,
 *   startMs?: number | undefined,
 *   endMs?: number | undefined,
 *   dualPage?: boolean | undefined,
 *   topOffset?: number | undefined,
 *   audioOffsetMs?: number | undefined
 * }} [options]
 * @returns {Promise<void>}
 */
export default function createVideo(mediaInfo, audioFile, videoFile, {
	ffmpeg = 'ffmpeg',
	fps = 60,
	width: outputWidth,
	startMs = 0,
	endMs,
	dualPage = false,
	topOffset = 0,
	audioOffsetMs = 0
} = {}) {
	const keyframes = getKeyframes(mediaInfo);
	const frameRate = fps;

	// Build page templates from raw SVG strings — avoids parse+build roundtrip that can lose text/font content
	const pageTemplates = mediaInfo.svgs.map(svgBase64 => {
		const svgObj = parseSvg(svgBase64);
		assert(!('line' in svgObj.svg[0]));
		assert(!('rect' in svgObj.svg[0]));

		const raw = Buffer.from(svgBase64, 'base64').toString();
		const svgStart = raw.indexOf('<svg');
		const tagEnd = raw.indexOf('>', svgStart);
		return {
			openTag: raw.slice(svgStart, tagEnd + 1),
			innerContent: raw.slice(tagEnd + 1, raw.lastIndexOf('</svg>')),
			viewBox: svgViewBox(svgObj)
		};
	});

	const { w: pageW, h: pageH } = pageTemplates[0].viewBox;
	const outW = outputWidth ?? Math.round(pageW);
	const outH = dualPage
		? Math.round(outW * pageH / (pageW * 2))
		: Math.round(outW * 9 / 16);

	// The first system on page 0 gets special treatment so the title is visible
	const firstSystem = keyframes
		.map(kf => kf.system)
		.reduce((min, s) => s.page < min.page || (s.page === min.page && s.y < min.y) ? s : min);

	// Cache background renders per system (Resvg called once per unique system, not per frame)
	/** @type {Map<object, { pixels: Buffer, scale: number, vbX: number, vbY: number }>} */
	const singlePageCache = new Map();

	/** @type {Map<number, { pixels: Buffer, scale: number }>} */
	const dualPageCache = new Map();

	/**
	 * @param {import('./types.js').ScoreElement} system
	 * @returns {{ pixels: Buffer, scale: number, vbX: number, vbY: number }}
	 */
	function getSinglePageBackground(system) {
		if (singlePageCache.has(system)) return /** @type {NonNullable<ReturnType<getSinglePageBackground>>} */(singlePageCache.get(system));

		const tmpl = pageTemplates[system.page];
		const margin = 196;

		let vbH, vbY;
		if (system === firstSystem) {
			// Pin viewport to top of page so title is always visible
			vbY = topOffset;
			vbH = Math.max(system.y / 12 + system.sy / 12 + margin - topOffset, pageW * 9 / 16);
		} else {
			vbH = Math.max(system.sy / 12 + 2 * margin, pageW * 9 / 16);
			vbY = (system.sy / 12 + 2 * margin > pageW * 9 / 16
				? system.y / 12 - margin
				: system.y / 12 + (system.sy / 12 - pageW * 9 / 16) / 2 + 36) + topOffset;
		}
		const vbW = vbH * 16 / 9;
		const vbX = (pageW - vbW) / 2;
		const scale = outW / vbW;

		const newTag = tmpl.openTag
			.replace(/viewBox="[^"]*"/, `viewBox="${vbX} ${vbY} ${vbW} ${vbH}"`)
			.replace(/ width="[^"]*"/, ` width="${outW}px"`)
			.replace(/ height="[^"]*"/, ` height="${outH}px"`);

		const svgStr = newTag
			+ `<rect x="${vbX}" y="${vbY}" width="${vbW}" height="${vbH}" fill="white"/>`
			+ tmpl.innerContent
			+ '</svg>';

		console.log('Rendering system page:%s y:%s', chalk.bold(system.page), chalk.bold(system.y));
		const rendered = new Resvg(svgStr).render();
		const result = { pixels: Buffer.from(rendered.pixels), scale, vbX, vbY };
		singlePageCache.set(system, result);
		return result;
	}

	/**
	 * @param {number} pageN
	 * @returns {{ pixels: Buffer, scale: number }}
	 */
	function getDualPageBackground(pageN) {
		if (dualPageCache.has(pageN)) return /** @type {NonNullable<ReturnType<getDualPageBackground>>} */(dualPageCache.get(pageN));

		const tmplN = pageTemplates[pageN];
		const tmplN1 = pageTemplates[pageN + 1];
		const totalW = pageW * 2;
		const scale = outW / totalW;

		let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalW} ${pageH}" width="${outW}px" height="${outH}px">`;
		s += `<rect x="0" y="0" width="${totalW}" height="${pageH}" fill="white"/>`;
		s += `<svg x="0" y="0" width="${pageW}" height="${pageH}" viewBox="0 ${topOffset} ${pageW} ${pageH}">${tmplN.innerContent}</svg>`;
		if (tmplN1 != null) {
			s += `<svg x="${pageW}" y="0" width="${pageW}" height="${pageH}" viewBox="0 ${topOffset} ${pageW} ${pageH}">${tmplN1.innerContent}</svg>`;
		}
		s += '</svg>';

		console.log('Rendering dual page:%s+%s', chalk.bold(pageN), chalk.bold(pageN + 1));
		const rendered = new Resvg(s).render();
		const result = { pixels: Buffer.from(rendered.pixels), scale };
		dualPageCache.set(pageN, result);
		return result;
	}

	let i = Math.floor(startMs / 1000 * frameRate);

	/**
	 * @returns {{ width: number, height: number, pixels: Buffer } | undefined}
	 */
	function getFrame() {
		const time = i++ / frameRate * 1000;

		if (endMs != null && time > endMs) {
			return;
		}

		const keyframeIndex = keyframes.findLastIndex(({ position }) => position <= time);

		if (keyframeIndex === -1) {
			return;
		}

		const lastKeyframe = keyframes[keyframes.length - 1];
		let system;
		let x;

		if (keyframeIndex === keyframes.length - 1) {
			if (audioFile == null) {
				return;
			}

			system = lastKeyframe.system;
			x = lastKeyframe.x;
		} else {
			const keyframe = keyframes[keyframeIndex];
			const nextKeyframe = keyframes[keyframeIndex + 1];
			system = keyframe.system;

			assert.strictEqual(system, nextKeyframe.system);

			x = keyframe.x
				+ (time - keyframe.position)
				/ (nextKeyframe.position - keyframe.position)
				* (nextKeyframe.x - keyframe.x);
		}

		console.log('Frame:%s Time:%s', chalk.bold(i), chalk.bold((time / 1000).toFixed(4)));

		if (dualPage) {
			// Always show even-paired pages together: {0,1}, {2,3}, {4,5}, …
			const pairedPageN = system.page - (system.page % 2);
			const { pixels: bgPixels, scale } = getDualPageBackground(pairedPageN);
			const output = Buffer.from(bgPixels);

			// If current page is the right half of the pair, offset x by one page width
			const xInPair = system.page % 2 === 1 ? pageW + x / 12 : x / 12;
			const lineXPx = Math.round(xInPair * scale);
			const ly1Px = Math.round((system.y / 12 - 55 - topOffset) * scale);
			const ly2Px = Math.round((system.y / 12 + system.sy / 12 + 55 - topOffset) * scale);

			drawLine(output, outW, outH, lineXPx, ly1Px, ly2Px, Math.max(1, Math.round(6 * scale)));
			return { width: outW, height: outH, pixels: output };
		} else {
			const { pixels: bgPixels, scale, vbX, vbY } = getSinglePageBackground(system);
			const output = Buffer.from(bgPixels);

			const lineXPx = Math.round((x / 12 - vbX) * scale);
			const ly1Px = Math.round((system.y / 12 - 55 - vbY) * scale);
			const ly2Px = Math.round((system.y / 12 + system.sy / 12 + 55 - vbY) * scale);

			drawLine(output, outW, outH, lineXPx, ly1Px, ly2Px, Math.max(1, Math.round(6 * scale)));
			return { width: outW, height: outH, pixels: output };
		}
	}

	const firstFrame = /** @type {NonNullable<ReturnType<typeof getFrame>>} */(getFrame());
	const { width, height } = firstFrame;

	const audioStartMs = startMs + audioOffsetMs;
	const audioArgs = audioFile != null ? [
		...(audioStartMs > 0 ? ['-ss', `${audioStartMs / 1000}`] : []),
		'-i', audioFile,
		...(endMs != null ? ['-t', `${(endMs - startMs) / 1000}`] : []),
		'-shortest'
	] : [];

	const proc = spawn(ffmpeg, [
		'-y',
		'-f', 'rawvideo',
		'-pix_fmt', 'rgba',
		'-s', `${width}x${height}`,
		'-r', `${frameRate}`,
		'-i', '-',
		...audioArgs,
		videoFile
	], { stdio: ['pipe', 'inherit', 'inherit'] });

	proc.stdin.on('drain', () => {
		let image;

		// eslint-disable-next-line no-cond-assign
		while (image = getFrame()) {
			assert.strictEqual(image.width, width);
			assert.strictEqual(image.height, height);

			if (!proc.stdin.write(image.pixels)) {
				return;
			}
		}

		proc.stdin.end();
	});

	// Handle case where ffmpeg terminates early (e.g., due to -shortest flag)
	proc.stdin.on('error', (err) => {
		if (err.code === 'EPIPE') {
			// ffmpeg has closed its stdin, which is normal when using -shortest
			// Just end our stream gracefully
			proc.stdin.end();
		} else {
			// Re-throw other errors
			proc.stdin.destroy(err);
		}
	});

	proc.stdin.write(firstFrame.pixels);

	return new Promise((resolve, reject) => {
		proc.on('close', resolve);
		proc.on('error', reject);
	});
}

/**
 * @param {Buffer} pixels
 * @param {number} width
 * @param {number} height
 * @param {number} x
 * @param {number} y1
 * @param {number} y2
 * @param {number} lineWidth
 */
function drawLine(pixels, width, height, x, y1, y2, lineWidth) {
	const half = Math.floor(lineWidth / 2);
	const r = 0x45, g = 0xa0, b = 0xd1;

	for (let y = Math.max(0, y1); y <= Math.min(height - 1, y2); y++) {
		for (let dx = -half; dx <= half; dx++) {
			const px = x + dx;
			if (px < 0 || px >= width) continue;
			const idx = (y * width + px) * 4;
			pixels[idx] = r;
			pixels[idx + 1] = g;
			pixels[idx + 2] = b;
			pixels[idx + 3] = 0xff;
		}
	}
}

/**
 * @param {import('./types.js').ScoreMedia} mediaInfo
 * @returns {Array<{
 *   position: number
 *   x: number
 *   system: import('./types.js').ScoreElement
 * }>}
 */
function getKeyframes(mediaInfo) {
	const mpos = parsePosXml(mediaInfo.mposXML);
	const spos = parsePosXml(mediaInfo.sposXML);
	assert(mpos.every(
		({ position }) => spos.filter(({ position: position1 }) => position === position1).length === 1
	));

	const measures = mpos.map(({ position, element }, i) => ({
		start: position,
		end: mpos[i + 1] ? mpos[i + 1].position : mediaInfo.metadata.duration * 1000,
		// eslint-disable-next-line stylistic/max-len
		.../** @type {import('./types.js').ScoreElement & { system: import('./types.js').ScoreElement }} */(
			element
		)
	}));

	/**
	 * @type {Record<string, Array<
	 *   & import('./types.js').ScoreElement
	 *   & { system: import('./types.js').ScoreElement }
	 * >>}
	 */
	const systems = {};

	measures.forEach(measure => {
		const key = `${measure.page}:${measure.y}`;

		if (!(key in systems)) {
			systems[key] = [];
		}

		systems[key].push(measure);
	});

	Object.values(systems).forEach(measures => {
		assert(measures.every(({ sy }) => sy === measures[0].sy));

		const x = Math.min(...measures.map(({ x }) => x));
		const system = {
			page: measures[0].page,
			x,
			y: measures[0].y,
			sx: Math.max(...measures.map(({ x, sx }) => x + sx)) - x,
			sy: measures[0].sy
		};

		measures.forEach(measure => {
			measure.system = system;
		});
	});

	const keyframes = measures.flatMap(({
		start, end, x, sx, system
	}) => [
		...spos
			.filter(({ position }) => position >= start && position < end)
			.map(({ position, element: { x } }) => ({ position, x, system })),
		{
			position: end,
			x: x + sx,
			system
		}
	]);

	assert.strictEqual(keyframes.length, spos.length + mpos.length);
	assert(keyframes.slice(1).every(({ position }, i) => keyframes[i].position <= position));

	return keyframes;
}

/**
 * @param {any} sposXml
 * @returns {Array<{
 *   position: number
 *   element: import('./types.js').ScoreElement
 * }>}
 */
function parsePosXml(sposXml) {
	const { score: [score] } = new xml.XMLParser({
		parseTagValue: false,
		ignoreAttributes: false,
		parseAttributeValue: false,
		isArray: (_, __, ___, isAttribute) => !isAttribute
	})
		.parse(Buffer.from(sposXml, 'base64'));

	const { elements: [{ element: elements }], events: [{ event: events }] } = score;

	assert(elements.every(/** @param {any} element @param {number} i */(element, i) => element['@_id'] === `${i}`));

	return events.map(/** @param {any} event */event => ({
		position: +event['@_position'],
		element: {
			x: +elements[event['@_elid']]['@_x'],
			y: +elements[event['@_elid']]['@_y'],
			sx: +elements[event['@_elid']]['@_sx'],
			sy: +elements[event['@_elid']]['@_sy'],
			page: +elements[event['@_elid']]['@_page']
		}
	}));
}

/**
 * @param {string} svg
 * @returns {any}
 */
function parseSvg(svg) {
	return new xml.XMLParser({
		parseTagValue: false,
		ignoreAttributes: false,
		parseAttributeValue: false,
		isArray: (_, __, ___, isAttribute) => !isAttribute
	})
		.parse(Buffer.from(svg, 'base64'));
}

/**
 * @param {any} svg
 * @returns {{ x: number, y: number, w: number, h: number }}
 */
function svgViewBox(svg) {
	const [x, y, w, h] = svg.svg[0]['@_viewBox'].split(' ').map(/** @param {any} i */i => Number(i));
	assert.strictEqual(x, 0);
	assert.strictEqual(y, 0);

	return { x, y, w, h };
}
