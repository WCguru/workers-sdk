import assert from "node:assert";
import getPort from "get-port";
import {
	Miniflare,
	type Response as MiniflareResponse,
	type MiniflareOptions,
} from "miniflare";
import * as undici from "undici";
import { beforeEach, afterEach, describe, test, expect, vi } from "vitest";
import { unstable_DevEnv as DevEnv } from "wrangler";
import type { ProxyData } from "../src/api";
import type { StartDevWorkerOptions } from "../src/api/startDevWorker/types";
import type { EsbuildBundle } from "../src/dev/use-esbuild";

const fakeBundle = {} as EsbuildBundle;

let devEnv: DevEnv;
let mf: Miniflare | undefined;
let res: MiniflareResponse | undici.Response | undefined;
let ws: undici.WebSocket | undefined;

type OptionalKeys<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

beforeEach(() => {
	devEnv = new DevEnv();
	mf = undefined;
	res = undefined;
	ws = undefined;
});
afterEach(async () => {
	// await new Promise((resolve) => setTimeout(resolve, 1000));

	await devEnv?.teardown();
	await mf?.dispose();
	await ws?.close();

	vi.resetAllMocks();
});

async function fakeStartUserWorker(options: {
	script: string;
	name?: string;
	mfOpts?: Partial<MiniflareOptions>;
	config?: OptionalKeys<StartDevWorkerOptions, "name" | "script">;
}) {
	const config: StartDevWorkerOptions = {
		...options.config,
		name: options.name ?? "test-worker",
		script: { contents: options.script },
		dev: {
			inspector: { port: await getPort() },
			...options.config?.dev,
		},
	};
	const mfOpts: MiniflareOptions = Object.assign(
		{
			port: 0,
			inspectorPort: await getPort(), // TODO: get workerd to report the inspectorPort so we can set 0 and retrieve the actual port later
			modules: true,
			compatibilityDate: "2023-08-01",
			name: config.name,
			script: options.script,
		},
		options.mfOpts
	);

	assert("script" in mfOpts);

	const worker = devEnv.startWorker(config);

	fakeConfigUpdate(config);
	fakeReloadStart(config);

	mf = new Miniflare(mfOpts);

	const url = await mf.ready;
	fakeReloadComplete(config, mfOpts, url);

	return { worker, mf, mfOpts, config, url };
}

async function fakeUserWorkerChanges({
	script,
	mfOpts,
	config,
}: {
	script?: string;
	mfOpts: MiniflareOptions;
	config: StartDevWorkerOptions;
}) {
	assert(mf);
	assert("script" in mfOpts);

	config = {
		...config,
		script: {
			...config.script,
			...(script ? { contents: script } : undefined),
		},
	};
	mfOpts = {
		...mfOpts,
		script: script ?? mfOpts.script,
	};

	fakeReloadStart(config);

	await mf.setOptions(mfOpts);

	const url = await mf.ready;
	fakeReloadComplete(config, mfOpts, url, 1000);

	return { mfOpts, config, mf, url };
}

function fireAndForgetFakeUserWorkerChanges(
	...args: Parameters<typeof fakeUserWorkerChanges>
) {
	// fire and forget the reload -- this let's us test request buffering
	void fakeUserWorkerChanges(...args);
}

function fakeConfigUpdate(config: StartDevWorkerOptions) {
	devEnv.proxy.onConfigUpdate({
		type: "configUpdate",
		config,
	});

	return config; // convenience to allow calling and defining new config inline but also store the new object
}
function fakeReloadStart(config: StartDevWorkerOptions) {
	devEnv.proxy.onReloadStart({
		type: "reloadStart",
		config,
		bundle: fakeBundle,
	});

	return config;
}
function fakeReloadComplete(
	config: StartDevWorkerOptions,
	mfOpts: MiniflareOptions,
	mfUrl: URL,
	delay = 100
) {
	const proxyData: ProxyData = {
		userWorkerUrl: {
			protocol: mfUrl.protocol,
			hostname: mfUrl.host,
			port: mfUrl.port,
		},
		userWorkerInspectorUrl: {
			protocol: "ws:",
			hostname: "127.0.0.1",
			port: String(mfOpts.inspectorPort),
			pathname: `/core:user:${config.name}`,
		},
		headers: {},
		liveReload: config.dev?.liveReload,
	};

	setTimeout(() => {
		devEnv.proxy.onReloadComplete({
			type: "reloadComplete",
			config,
			bundle: fakeBundle,
			proxyData,
		});
	}, delay);

	return { config, mfOpts }; // convenience to allow calling and defining new config/mfOpts inline but also store the new objects
}

describe("startDevWorker: ProxyController", () => {
	test("ProxyWorker buffers requests while runtime reloads", async () => {
		const run = await fakeStartUserWorker({
			script: `
				export default {
					fetch() {
						return new Response("body:1");
					}
				}
			`,
		});

		res = await run.worker.fetch("http://dummy");
		await expect(res.text()).resolves.toBe("body:1");

		fireAndForgetFakeUserWorkerChanges({
			mfOpts: run.mfOpts,
			config: run.config,
			script: run.mfOpts.script.replace("1", "2"),
		});

		res = await run.worker.fetch("http://dummy");
		await expect(res.text()).resolves.toBe("body:2");
	});

	test("InspectorProxyWorker discovery endpoints + devtools websocket connection", async () => {
		const run = await fakeStartUserWorker({
			script: `
				export default {
					fetch() {
						console.log('Inside mock user worker');

						return new Response("body:1");
					}
				}
			`,
			config: { dev: { inspector: { port: await getPort() } } },
		});

		await devEnv.proxy.ready;
		res = await undici.fetch(
			`http://127.0.0.1:${run.config.dev?.inspector?.port}/json`
		);

		await expect(res.json()).resolves.toBeInstanceOf(Array);

		ws = new undici.WebSocket(
			`ws://127.0.0.1:${run.config.dev?.inspector?.port}/core:user:${run.config.name}`
		);
		const openPromise = new Promise((resolve) => {
			ws?.addEventListener("open", resolve);
		});
		const consoleAPICalledPromise = new Promise((resolve) => {
			ws?.addEventListener("message", (event) => {
				assert(typeof event.data === "string");
				if (event.data.includes("Runtime.consoleAPICalled")) {
					resolve(JSON.parse(event.data));
				}
			});
		});
		const executionContextCreatedPromise = new Promise((resolve) => {
			ws?.addEventListener("message", (event) => {
				assert(typeof event.data === "string");
				if (event.data.includes("Runtime.executionContextCreated")) {
					resolve(JSON.parse(event.data));
				}
			});
		});

		await openPromise;
		await run.worker.fetch("http://localhost");

		await expect(consoleAPICalledPromise).resolves.toMatchObject({
			method: "Runtime.consoleAPICalled",
			params: {
				args: expect.arrayContaining([
					{ type: "string", value: "Inside mock user worker" },
				]),
			},
		});
		await expect(executionContextCreatedPromise).resolves.toMatchObject({
			method: "Runtime.executionContextCreated",
			params: {
				context: { id: 1 },
			},
		});
	});

	test.only(
		"User worker exception",
		async () => {
			const consoleErrorSpy = vi.spyOn(console, "error");

			const run = await fakeStartUserWorker({
				script: `
					export default {
						fetch() {
							throw new Error('Boom!');

							return new Response("body:1");
						}
					}
				`,
			});

			res = await run.worker.fetch("http://dummy");
			await expect(res.text()).resolves.toBe("Error: Boom!");

			expect(consoleErrorSpy).toBeCalledWith(
				expect.stringContaining("Error: Boom!")
			);

			// test changes causing a new error cause the new error to propogate
			fireAndForgetFakeUserWorkerChanges({
				script: `
					export default {
						fetch() {
							throw new Error('Boom 2!');

							return new Response("body:2");
						}
					}
				`,
				mfOpts: run.mfOpts,
				config: run.config,
			});

			res = await run.worker.fetch("http://dummy");
			await expect(res.text()).resolves.toMatchInlineSnapshot('"Error: Boom 2!"');

			expect(consoleErrorSpy).toBeCalledWith(
				expect.stringContaining("Error: Boom 2!")
			);

			// test eyeball requests receive the pretty error page
			fireAndForgetFakeUserWorkerChanges({
				script: `
					export default {
						fetch() {
							const e = new Error('Boom 3!');

							// this is how errors are serialised after they are caught by wrangler/miniflare3 middlewares
							const error = { name: e.name, message: e.message, stack: e.stack };
							return Response.json(error, {
								status: 500,
								headers: { "MF-Experimental-Error-Stack": "true" },
							});
						}
					}
				`,
				mfOpts: run.mfOpts,
				config: run.config,
			});

			const proxyWorkerUrl = await devEnv.proxy.proxyWorker?.ready;
			assert(proxyWorkerUrl);
			res = await undici.fetch(proxyWorkerUrl, {
				headers: { Accept: "text/html" },
			});
			await expect(res.text()).resolves.toMatchInlineSnapshot(`
				"<!DOCTYPE html>
				<html lang=\\"en\\">
				<head>
				  <meta charset=\\"UTF-8\\">
				  <title> </title>
				  <link href=\\"https://fonts.googleapis.com/css?family=Source+Sans+Pro:300,400,500,600\\" rel=\\"stylesheet\\">

				  <style type=\\"text/css\\">
				    /* http://prismjs.com/download.html?themes=prism&languages=markup+css+clike+javascript&plugins=line-highlight+line-numbers+toolbar+show-language */
				/**
				 * prism.js default theme for JavaScript, CSS and HTML
				 * Based on dabblet (http://dabblet.com)
				 * @author Lea Verou
				 */
				code[class*=\\"language-\\"],
				pre[class*=\\"language-\\"] {
				  color: black;
				  background: none;
				  text-shadow: 0 1px white;
				  font-family: Consolas, Monaco, 'Andale Mono', 'Ubuntu Mono', monospace;
				  text-align: left;
				  white-space: pre;
				  word-spacing: normal;
				  word-break: normal;
				  word-wrap: normal;
				  line-height: 1.8;

				  -moz-tab-size: 4;
				  -o-tab-size: 4;
				  tab-size: 4;

				  -webkit-hyphens: none;
				  -moz-hyphens: none;
				  -ms-hyphens: none;
				  hyphens: none;
				}

				pre[class*=\\"language-\\"]::-moz-selection, pre[class*=\\"language-\\"] ::-moz-selection,
				code[class*=\\"language-\\"]::-moz-selection, code[class*=\\"language-\\"] ::-moz-selection {
				  text-shadow: none;
				  background: #b3d4fc;
				}

				pre[class*=\\"language-\\"]::selection, pre[class*=\\"language-\\"] ::selection,
				code[class*=\\"language-\\"]::selection, code[class*=\\"language-\\"] ::selection {
				  text-shadow: none;
				  background: #b3d4fc;
				}

				@media print {
				  code[class*=\\"language-\\"],
				  pre[class*=\\"language-\\"] {
				    text-shadow: none;
				  }
				}

				/* Code blocks */
				pre[class*=\\"language-\\"] {
				  padding: 1em;
				  margin: .5em 0;
				  overflow: auto;
				}

				:not(pre) > code[class*=\\"language-\\"],
				pre[class*=\\"language-\\"] {
				  background: #f5f2f0;
				}

				/* Inline code */
				:not(pre) > code[class*=\\"language-\\"] {
				  padding: .1em;
				  border-radius: .3em;
				  white-space: normal;
				}

				.token.comment,
				.token.prolog,
				.token.doctype,
				.token.cdata {
				  color: slategray;
				}

				.token.punctuation {
				  color: #999;
				}

				.namespace {
				  opacity: .7;
				}

				.token.property,
				.token.tag,
				.token.boolean,
				.token.number,
				.token.constant,
				.token.symbol,
				.token.deleted {
				  color: #905;
				}

				.token.selector,
				.token.attr-name,
				.token.string,
				.token.char,
				.token.builtin,
				.token.inserted {
				  color: #690;
				}

				.token.operator,
				.token.entity,
				.token.url,
				.language-css .token.string,
				.style .token.string {
				  color: #a67f59;
				  background: hsla(0, 0%, 100%, .5);
				}

				.token.atrule,
				.token.attr-value,
				.token.keyword {
				  color: #07a;
				}

				.token.function {
				  color: #DD4A68;
				}

				.token.regex,
				.token.important,
				.token.variable {
				  color: #e90;
				}

				.token.important,
				.token.bold {
				  font-weight: bold;
				}
				.token.italic {
				  font-style: italic;
				}

				.token.entity {
				  cursor: help;
				}

				pre[data-line] {
				  position: relative;
				  padding: 1em 0 1em 3em;
				}

				.line-highlight {
				  position: absolute;
				  left: 0;
				  right: 0;
				  padding: inherit 0;
				  margin-top: 1em; /* Same as .prism’s padding-top */

				  background: hsla(24, 20%, 50%,.08);
				  background: linear-gradient(to right, hsla(24, 20%, 50%,.1) 70%, hsla(24, 20%, 50%,0));

				  pointer-events: none;

				  line-height: inherit;
				  white-space: pre;
				}

				  .line-highlight:before,
				  .line-highlight[data-end]:after {
				    content: attr(data-start);
				    position: absolute;
				    top: .6em;
				    left: .4em;
				    min-width: 1em;
				    padding: 0 .5em;
				    background-color: hsla(24, 20%, 50%,.4);
				    color: hsl(24, 20%, 95%);
				    font: bold 65%/1.5 sans-serif;
				    text-align: center;
				    vertical-align: .3em;
				    border-radius: 999px;
				    text-shadow: none;
				    box-shadow: 0 1px white;
				  }

				  .line-highlight[data-end]:after {
				    content: attr(data-end);
				    top: auto;
				    bottom: .4em;
				  }

				pre.line-numbers {
				  position: relative;
				  padding-left: 3.8em;
				  counter-reset: linenumber;
				}

				pre.line-numbers > code {
				  position: relative;
				  display: block;
				}

				.line-numbers .line-numbers-rows {
				  position: absolute;
				  pointer-events: none;
				  top: 0;
				  font-size: 100%;
				  left: -3.0em;
				  width: 3em; /* works for line-numbers below 1000 lines */
				  letter-spacing: -1px;
				  border-right: 1px solid #999;

				  -webkit-user-select: none;
				  -moz-user-select: none;
				  -ms-user-select: none;
				  user-select: none;

				}

				  .line-numbers-rows > span {
				    pointer-events: none;
				    display: block;
				    counter-increment: linenumber;
				  }

				    .line-numbers-rows > span:before {
				      content: counter(linenumber);
				      color: #999;
				      display: block;
				      padding-right: 0.8em;
				      text-align: right;
				    }
				pre.code-toolbar {
				  position: relative;
				}

				pre.code-toolbar > .toolbar {
				  position: absolute;
				  top: .3em;
				  right: .2em;
				  transition: opacity 0.3s ease-in-out;
				  opacity: 0;
				}

				pre.code-toolbar:hover > .toolbar {
				  opacity: 1;
				}

				pre.code-toolbar > .toolbar .toolbar-item {
				  display: inline-block;
				}

				pre.code-toolbar > .toolbar a {
				  cursor: pointer;
				}

				pre.code-toolbar > .toolbar button {
				  background: none;
				  border: 0;
				  color: inherit;
				  font: inherit;
				  line-height: normal;
				  overflow: visible;
				  padding: 0;
				  -webkit-user-select: none; /* for button */
				  -moz-user-select: none;
				  -ms-user-select: none;
				}

				pre.code-toolbar > .toolbar a,
				pre.code-toolbar > .toolbar button,
				pre.code-toolbar > .toolbar span {
				  color: #bbb;
				  font-size: .8em;
				  padding: 0 .5em;
				  background: #f5f2f0;
				  background: rgba(224, 224, 224, 0.2);
				  box-shadow: 0 2px 0 0 rgba(0,0,0,0.2);
				  border-radius: .5em;
				}

				pre.code-toolbar > .toolbar a:hover,
				pre.code-toolbar > .toolbar a:focus,
				pre.code-toolbar > .toolbar button:hover,
				pre.code-toolbar > .toolbar button:focus,
				pre.code-toolbar > .toolbar span:hover,
				pre.code-toolbar > .toolbar span:focus {
				  color: inherit;
				  text-decoration: none;
				}

				@keyframes hover-color {
				  from {
				    border-color: #c0c0c0; }
				  to {
				    border-color: #3e97eb; } }

				.magic-radio,
				.magic-checkbox {
				  position: absolute;
				  display: none; }

				.magic-radio[disabled],
				.magic-checkbox[disabled] {
				  cursor: not-allowed; }

				.magic-radio + label,
				.magic-checkbox + label {
				  position: relative;
				  display: block;
				  padding-left: 30px;
				  cursor: pointer;
				  vertical-align: middle; }
				  .magic-radio + label:hover:before,
				  .magic-checkbox + label:hover:before {
				    animation-duration: 0.4s;
				    animation-fill-mode: both;
				    animation-name: hover-color; }
				  .magic-radio + label:before,
				  .magic-checkbox + label:before {
				    position: absolute;
				    top: 0;
				    left: 0;
				    display: inline-block;
				    width: 20px;
				    height: 20px;
				    content: '';
				    border: 1px solid #c0c0c0; }
				  .magic-radio + label:after,
				  .magic-checkbox + label:after {
				    position: absolute;
				    display: none;
				    content: ''; }

				.magic-radio[disabled] + label,
				.magic-checkbox[disabled] + label {
				  cursor: not-allowed;
				  color: #e4e4e4; }
				  .magic-radio[disabled] + label:hover, .magic-radio[disabled] + label:before, .magic-radio[disabled] + label:after,
				  .magic-checkbox[disabled] + label:hover,
				  .magic-checkbox[disabled] + label:before,
				  .magic-checkbox[disabled] + label:after {
				    cursor: not-allowed; }
				  .magic-radio[disabled] + label:hover:before,
				  .magic-checkbox[disabled] + label:hover:before {
				    border: 1px solid #e4e4e4;
				    animation-name: none; }
				  .magic-radio[disabled] + label:before,
				  .magic-checkbox[disabled] + label:before {
				    border-color: #e4e4e4; }

				.magic-radio:checked + label:before,
				.magic-checkbox:checked + label:before {
				  animation-name: none; }

				.magic-radio:checked + label:after,
				.magic-checkbox:checked + label:after {
				  display: block; }

				.magic-radio + label:before {
				  border-radius: 50%; }

				.magic-radio + label:after {
				  top: 6px;
				  left: 6px;
				  width: 8px;
				  height: 8px;
				  border-radius: 50%;
				  background: #3e97eb; }

				.magic-radio:checked + label:before {
				  border: 1px solid #3e97eb; }

				.magic-radio:checked[disabled] + label:before {
				  border: 1px solid #c9e2f9; }

				.magic-radio:checked[disabled] + label:after {
				  background: #c9e2f9; }

				.magic-checkbox + label:before {
				  border-radius: 3px; }

				.magic-checkbox + label:after {
				  top: 2px;
				  left: 7px;
				  box-sizing: border-box;
				  width: 6px;
				  height: 12px;
				  transform: rotate(45deg);
				  border-width: 2px;
				  border-style: solid;
				  border-color: #fff;
				  border-top: 0;
				  border-left: 0; }

				.magic-checkbox:checked + label:before {
				  border: #3e97eb;
				  background: #3e97eb; }

				.magic-checkbox:checked[disabled] + label:before {
				  border: #c9e2f9;
				  background: #c9e2f9; }

				html, body {
				  height: 100%;
				  width: 100%;
				}

				body {
				  font-family: 'Source Sans Pro', -apple-system, BlinkMacSystemFont, \\"Segoe UI\\", Roboto, \\"Helvetica Neue\\", Arial, sans-serif;
				  font-size: 14px;
				  line-height: 24px;
				  color: #444;
				}

				.fab {
				  font-family: \\"Font Awesome 5 Brands\\";
				  -webkit-font-smoothing: antialiased;
				  color: #afafaf;
				  font-size: 24px;
				}

				* {
				  padding: 0;
				  margin: 0;
				}

				.error-page {
				  display: flex;
				  flex-direction: column;
				  width: 100%;
				  height: 100%;
				}

				.error-stack {
				  background: #edecea;
				  padding: 100px 80px;
				  box-sizing: border-box;
				}

				.error-status {
				  color: #afafaf;
				  font-size: 150px;
				  position: absolute;
				  opacity: 0.2;
				  right: 80px;
				  top: 80px;
				  font-weight: 600;
				  margin-bottom: 10px;
				}

				.error-name {
				  color: #db5461;
				  font-size: 18px;
				  font-family: Menlo, SFMono-Regular, Monaco, \\"Fira Code\\", \\"Fira Mono\\", Consolas, \\"Liberation Mono\\", \\"Courier New\\", monospace;
				  font-weight: 600;
				  margin-bottom: 15px;
				}

				.error-message {
				  font-weight: 300;
				  font-size: 40px;
				  line-height: 48px;
				}

				.error-title {
				  border-bottom: 1px solid #d0cfcf;
				  padding-bottom: 15px;
				  margin-bottom: 20px;
				}

				.error-links {
				  margin-top: 20px;
				}

				.error-links a {
				  margin-right: 8px;
				}

				.error-frames {
				  display: flex;
				  flex-direction: row-reverse;
				}

				.frame-preview {
				  background: #fff;
				  width: 50%;
				  box-shadow: 0px 0px 9px #d3d3d3;
				  height: 100%;
				  box-sizing: border-box;
				  overflow: auto;
				}

				.frame-stack {
				  margin-right: 40px;
				  flex: 1;
				  padding: 10px 0;
				  box-sizing: border-box;
				}

				.frames-list {
				  overflow: auto;
				  max-height: 334px;
				}

				.frames-filter-selector {
				  margin-bottom: 30px;
				  margin-left: 8px;
				}

				.request-details {
				  padding: 50px 80px;
				}

				.request-title {
				  text-transform: uppercase;
				  font-size: 18px;
				  letter-spacing: 1px;
				  padding: 0 5px 5px 5px;
				  margin-bottom: 15px;
				}

				.request-details table {
				  width: 100%;
				  border-collapse: collapse;
				  margin-bottom: 80px;
				}

				.request-details table td {
				  padding: 6px 5px;
				  font-size: 14px;
				  letter-spacing: 0.4px;
				  color: #455275;
				  border-bottom: 1px solid #e8e8e8;
				  word-break: break-word;
				}

				.request-details table td.title {
				  color: #999;
				  width: 40%;
				  font-size: 14px;
				  font-weight: 600;
				  text-transform: uppercase;
				}

				code[class*=\\"language-\\"], pre[class*=\\"language-\\"] {
				  background: transparent;
				  font-size: 13px;
				  line-height: 1.8;
				}

				.line-numbers .line-numbers-rows {
				  border: none;
				}

				.frame-row {
				  display: flex;
				  justify-content: space-between;
				  padding: 6px 34px 6px 10px;
				  position: relative;
				  cursor: pointer;
				  transition: background 300ms ease;
				}

				.frame-row.native-frame {
				  display: none;
				  opacity: 0.4;
				}

				.frame-row.native-frame.force-show {
				  display: flex;
				}

				.frame-row:after {
				  content: \\"\\";
				  background: #db5461;
				  position: absolute;
				  top: 50%;
				  right: 10px;
				  transform: translateY(-50%);
				  height: 10px;
				  width: 10px;
				  border-radius: 24px;
				}

				.frame-row:hover, .frame-row.active {
				  background: #fff;
				}

				.frame-row.active {
				  opacity: 1;
				}

				.frame-row-filepath {
				  color: #455275;
				  font-weight: 600;
				  margin-right: 15px;
				}

				.frame-context {
				  display: none;
				}

				.frame-row-code {
				  color: #999;
				}

				#frame-file {
				  color: #455275;
				  font-weight: 600;
				  border-bottom: 1px solid #e8e8e8;
				  padding: 10px 22px;
				}

				#frame-method {
				  color: #999;
				  font-weight: 400;
				  border-top: 1px solid #e8e8e8;
				  padding: 10px 22px;
				}

				.is-hidden {
				  display: none;
				}

				@media only screen and (max-width: 970px) {
				  .error-frames {
				    flex-direction: column-reverse;
				  }

				  .frame-preview {
				    width: 100%;
				  }

				  .frame-stack {
				    width: 100%;
				  }
				}

				  </style>

				</head>
				<body>
				  <section class=\\"error-page\\">
				    <section class=\\"error-stack\\">
				      <h3 class=\\"error-status\\"></h3>

				      <div class=\\"error-title\\">
				        <h4 class=\\"error-name\\"> Error </h4>
				        <h2 class=\\"error-message\\"> Boom 3! </h2>
				        <p class=\\"error-links\\">
				            <a href=\\"https://developers.cloudflare.com/workers/\\" target=\\"_blank\\" style=\\"text-decoration:none\\">📚 Workers Docs</a><a href=\\"https://discord.gg/cloudflaredev\\" target=\\"_blank\\" style=\\"text-decoration:none\\">💬 Workers Discord</a>
				        </p>
				      </div>

				      <div class=\\"error-frames\\">
				        <div class=\\"frame-preview is-hidden\\">
				          <div id=\\"frame-file\\"></div>
				          <div id=\\"frame-code\\"><pre class=\\"line-numbers\\"><code class=\\"language-js\\" id=\\"code-drop\\"></code></pre></div>
				          <div id=\\"frame-method\\"></div>
				        </div>

				        <div class=\\"frame-stack\\">
				          <div class=\\"frames-filter-selector\\">
				            <input type=\\"checkbox\\" class=\\"magic-checkbox\\" name=\\"frames-filter\\" id=\\"frames-filter\\" >
				            <label for=\\"frames-filter\\">Show all frames</label>
				          </div>

				          <div class=\\"frames-list\\">
				          </div>
				        </div>
				      </div>
				    </section>

				      <section class=\\"request-details\\">
				        <h2 class=\\"request-title\\"> Request Details </h2>

				        <table>
				          <tr>
				            <td class=\\"title\\"> URI </td>
				            <td> http:&#x2F;&#x2F;localhost&#x2F;core&#x2F;error </td>
				          </tr>

				          <tr>
				            <td class=\\"title\\"> Request Method </td>
				            <td> POST </td>
				          </tr>

				          <tr>
				            <td class=\\"title\\"> HTTP Version </td>
				            <td>  </td>
				          </tr>

				          <tr>
				            <td class=\\"title\\"> Connection </td>
				            <td>  </td>
				          </tr>
				        </table>

				        <h2 class=\\"request-title\\"> Headers </h2>

				        <table>
				            <tr>
				              <td class=\\"title\\"> ACCEPT </td>
				              <td> text&#x2F;html </td>
				            </tr>
				            <tr>
				              <td class=\\"title\\"> ACCEPT-ENCODING </td>
				              <td> gzip, deflate </td>
				            </tr>
				            <tr>
				              <td class=\\"title\\"> ACCEPT-LANGUAGE </td>
				              <td> * </td>
				            </tr>
				            <tr>
				              <td class=\\"title\\"> CONTENT-LENGTH </td>
				              <td> 100 </td>
				            </tr>
				            <tr>
				              <td class=\\"title\\"> HOST </td>
				              <td> localhost </td>
				            </tr>
				            <tr>
				              <td class=\\"title\\"> SEC-FETCH-MODE </td>
				              <td> cors </td>
				            </tr>
				            <tr>
				              <td class=\\"title\\"> USER-AGENT </td>
				              <td> undici </td>
				            </tr>
				        </table>

				        <h2 class=\\"request-title\\"> Cookies </h2>
				        <table>
				        </table>
				      </section>
				  </section>
				  <script type=\\"text/javascript\\">
				    !function(e,t){\\"function\\"==typeof define&&define.amd?define(function(){return t(e)}):t(e)}(this,function(h){$=(i=[]).concat,a=i.filter,u=i.slice,f=h.document,p={},t={},I={\\"column-count\\":1,columns:1,\\"font-weight\\":1,\\"line-height\\":1,opacity:1,\\"z-index\\":1,zoom:1},_=/^\\\\s*<(\\\\w+|!)[^>]*>/,B=/^<(\\\\w+)\\\\s*\\\\/?>(?:<\\\\/\\\\1>|)$/,q=/<(?!area|br|col|embed|hr|img|input|link|meta|param)(([\\\\w:]+)[^>]*)\\\\/>/gi,z=/^(?:body|html)$/i,H=/([A-Z])/g,W=[\\"val\\",\\"css\\",\\"html\\",\\"text\\",\\"data\\",\\"width\\",\\"height\\",\\"offset\\"],e=f.createElement(\\"table\\"),R=f.createElement(\\"tr\\"),Z={tr:f.createElement(\\"tbody\\"),tbody:e,thead:e,tfoot:e,td:R,th:R,\\"*\\":f.createElement(\\"div\\")},V=/complete|loaded|interactive/,J=/^[\\\\w-]*$/,U=(X={}).toString,d={},G=f.createElement(\\"div\\"),Y={tabindex:\\"tabIndex\\",readonly:\\"readOnly\\",for:\\"htmlFor\\",class:\\"className\\",maxlength:\\"maxLength\\",cellspacing:\\"cellSpacing\\",cellpadding:\\"cellPadding\\",rowspan:\\"rowSpan\\",colspan:\\"colSpan\\",usemap:\\"useMap\\",frameborder:\\"frameBorder\\",contenteditable:\\"contentEditable\\"},m=Array.isArray||function(e){return e instanceof Array},d.matches=function(e,t){var n,r;return!(!t||!e||1!==e.nodeType)&&((n=e.matches||e.webkitMatchesSelector||e.mozMatchesSelector||e.oMatchesSelector||e.matchesSelector)?n.call(e,t):((r=!(n=e.parentNode))&&(n=G).appendChild(e),n=~d.qsa(n,t).indexOf(e),r&&G.removeChild(e),n))},s=function(e){return e.replace(/-+(.)?/g,function(e,t){return t?t.toUpperCase():\\"\\"})},n=function(n){return a.call(n,function(e,t){return n.indexOf(e)==t})},d.fragment=function(e,t,n){var r,i,a;return(r=B.test(e)?c(f.createElement(RegExp.$1)):r)||(e.replace&&(e=e.replace(q,\\"<$1></$2>\\")),t===l&&(t=_.test(e)&&RegExp.$1),(a=Z[t=t in Z?t:\\"*\\"]).innerHTML=\\"\\"+e,r=c.each(u.call(a.childNodes),function(){a.removeChild(this)})),A(n)&&(i=c(r),c.each(n,function(e,t){-1<W.indexOf(e)?i[e](t):i.attr(e,t)})),r},d.Z=function(e,t){return new Se(e,t)},d.isZ=function(e){return e instanceof d.Z},d.init=function(e,t){var n,r;if(!e)return d.Z();if(\\"string\\"==typeof e)if(\\"<\\"==(e=e.trim())[0]&&_.test(e))n=d.fragment(e,RegExp.$1,t),e=null;else{if(t!==l)return c(t).find(e);n=d.qsa(f,e)}else{if(k(e))return c(f).ready(e);if(d.isZ(e))return e;if(m(e))r=e,n=a.call(r,function(e){return null!=e});else if(C(e))n=[e],e=null;else if(_.test(e))n=d.fragment(e.trim(),RegExp.$1,t),e=null;else{if(t!==l)return c(t).find(e);n=d.qsa(f,e)}}return d.Z(n,e)},(c=function(e,t){return d.init(e,t)}).extend=function(t){var n,e=u.call(arguments,1);return\\"boolean\\"==typeof t&&(n=t,t=e.shift()),e.forEach(function(e){!function e(t,n,r){for(o in n)r&&(A(n[o])||m(n[o]))?(A(n[o])&&!A(t[o])&&(t[o]={}),m(n[o])&&!m(t[o])&&(t[o]=[]),e(t[o],n[o],r)):n[o]!==l&&(t[o]=n[o])}(t,e,n)}),t},d.qsa=function(e,t){var n,r=\\"#\\"==t[0],i=!r&&\\".\\"==t[0],a=r||i?t.slice(1):t,o=J.test(a);return e.getElementById&&o&&r?(n=e.getElementById(a))?[n]:[]:1!==e.nodeType&&9!==e.nodeType&&11!==e.nodeType?[]:u.call(o&&!r&&e.getElementsByClassName?i?e.getElementsByClassName(a):e.getElementsByTagName(t):e.querySelectorAll(t))},c.contains=f.documentElement.contains?function(e,t){return e!==t&&e.contains(t)}:function(e,t){for(;t=t&&t.parentNode;)if(t===e)return!0;return!1},c.type=S,c.isFunction=k,c.isWindow=ve,c.isArray=m,c.isPlainObject=A,c.isEmptyObject=function(e){for(var t in e)return!1;return!0},c.isNumeric=function(e){var t=Number(e),n=typeof e;return null!=e&&\\"boolean\\"!=n&&(\\"string\\"!=n||e.length)&&!isNaN(t)&&isFinite(t)||!1},c.inArray=function(e,t,n){return i.indexOf.call(t,e,n)},c.camelCase=s,c.trim=function(e){return null==e?\\"\\":String.prototype.trim.call(e)},c.uuid=0,c.support={},c.expr={},c.noop=function(){},c.map=function(e,t){var n,r,i,a,o=[];if(xe(e))for(r=0;r<e.length;r++)null!=(n=t(e[r],r))&&o.push(n);else for(i in e)null!=(n=t(e[i],i))&&o.push(n);return 0<(a=o).length?c.fn.concat.apply([],a):a},c.each=function(e,t){var n,r;if(xe(e)){for(n=0;n<e.length;n++)if(!1===t.call(e[n],n,e[n]))return e}else for(r in e)if(!1===t.call(e[r],r,e[r]))return e;return e},c.grep=function(e,t){return a.call(e,t)},h.JSON&&(c.parseJSON=JSON.parse),c.each(\\"Boolean Number String Function Array Date RegExp Object Error\\".split(\\" \\"),function(e,t){X[\\"[object \\"+t+\\"]\\"]=t.toLowerCase()}),c.fn={constructor:d.Z,length:0,forEach:i.forEach,reduce:i.reduce,push:i.push,sort:i.sort,splice:i.splice,indexOf:i.indexOf,concat:function(){for(var e,t=[],n=0;n<arguments.length;n++)t[n]=d.isZ(e=arguments[n])?e.toArray():e;return $.apply(d.isZ(this)?this.toArray():this,t)},map:function(n){return c(c.map(this,function(e,t){return n.call(e,t,e)}))},slice:function(){return c(u.apply(this,arguments))},ready:function(e){return V.test(f.readyState)&&f.body?e(c):f.addEventListener(\\"DOMContentLoaded\\",function(){e(c)},!1),this},get:function(e){return e===l?u.call(this):this[0<=e?e:e+this.length]},toArray:function(){return this.get()},size:function(){return this.length},remove:function(){return this.each(function(){null!=this.parentNode&&this.parentNode.removeChild(this)})},each:function(n){return i.every.call(this,function(e,t){return!1!==n.call(e,t,e)}),this},filter:function(t){return k(t)?this.not(this.not(t)):c(a.call(this,function(e){return d.matches(e,t)}))},add:function(e,t){return c(n(this.concat(c(e,t))))},is:function(e){return 0<this.length&&d.matches(this[0],e)},not:function(t){var n,r=[];return k(t)&&t.call!==l?this.each(function(e){t.call(this,e)||r.push(this)}):(n=\\"string\\"==typeof t?this.filter(t):xe(t)&&k(t.item)?u.call(t):c(t),this.forEach(function(e){n.indexOf(e)<0&&r.push(e)})),c(r)},has:function(e){return this.filter(function(){return C(e)?c.contains(this,e):c(this).find(e).size()})},eq:function(e){return-1===e?this.slice(e):this.slice(e,+e+1)},first:function(){var e=this[0];return e&&!C(e)?e:c(e)},last:function(){var e=this[this.length-1];return e&&!C(e)?e:c(e)},find:function(e){var n=this,t=e?\\"object\\"==typeof e?c(e).filter(function(){var t=this;return i.some.call(n,function(e){return c.contains(e,t)})}):1==this.length?c(d.qsa(this[0],e)):this.map(function(){return d.qsa(this,e)}):c();return t},closest:function(n,r){var i=[],a=\\"object\\"==typeof n&&c(n);return this.each(function(e,t){for(;t&&!(a?0<=a.indexOf(t):d.matches(t,n));)t=t!==r&&!be(t)&&t.parentNode;t&&i.indexOf(t)<0&&i.push(t)}),c(i)},parents:function(e){for(var t=[],n=this;0<n.length;)n=c.map(n,function(e){if((e=e.parentNode)&&!be(e)&&t.indexOf(e)<0)return t.push(e),e});return ke(t,e)},parent:function(e){return ke(n(this.pluck(\\"parentNode\\")),e)},children:function(e){return ke(this.map(function(){return Pe(this)}),e)},contents:function(){return this.map(function(){return this.contentDocument||u.call(this.childNodes)})},siblings:function(e){return ke(this.map(function(e,t){return a.call(Pe(t.parentNode),function(e){return e!==t})}),e)},empty:function(){return this.each(function(){this.innerHTML=\\"\\"})},pluck:function(t){return c.map(this,function(e){return e[t]})},show:function(){return this.each(function(){var e,t,n;\\"none\\"==this.style.display&&(this.style.display=\\"\\"),\\"none\\"==getComputedStyle(this,\\"\\").getPropertyValue(\\"display\\")&&(this.style.display=(e=this.nodeName,p[e]||(t=f.createElement(e),f.body.appendChild(t),n=getComputedStyle(t,\\"\\").getPropertyValue(\\"display\\"),t.parentNode.removeChild(t),p[e]=n=\\"none\\"==n?\\"block\\":n),p[e]))})},replaceWith:function(e){return this.before(e).remove()},wrap:function(t){var n,r,i=k(t);return this[0]&&!i&&(n=c(t).get(0),r=n.parentNode||1<this.length),this.each(function(e){c(this).wrapAll(i?t.call(this,e):r?n.cloneNode(!0):n)})},wrapAll:function(e){if(this[0]){var t;for(c(this[0]).before(e=c(e));(t=e.children()).length;)e=t.first();c(e).append(this)}return this},wrapInner:function(r){var i=k(r);return this.each(function(e){var t=c(this),n=t.contents(),e=i?r.call(this,e):r;n.length?n.wrapAll(e):t.append(e)})},unwrap:function(){return this.parent().each(function(){c(this).replaceWith(c(this).children())}),this},clone:function(){return this.map(function(){return this.cloneNode(!0)})},hide:function(){return this.css(\\"display\\",\\"none\\")},toggle:function(t){return this.each(function(){var e=c(this);(t===l?\\"none\\"==e.css(\\"display\\"):t)?e.show():e.hide()})},prev:function(e){return c(this.pluck(\\"previousElementSibling\\")).filter(e||\\"*\\")},next:function(e){return c(this.pluck(\\"nextElementSibling\\")).filter(e||\\"*\\")},html:function(n){return 0 in arguments?this.each(function(e){var t=this.innerHTML;c(this).empty().append(j(this,n,e,t))}):0 in this?this[0].innerHTML:null},text:function(t){return 0 in arguments?this.each(function(e){e=j(this,t,e,this.textContent);this.textContent=null==e?\\"\\":\\"\\"+e}):0 in this?this.pluck(\\"textContent\\").join(\\"\\"):null},attr:function(t,n){var e;return\\"string\\"!=typeof t||1 in arguments?this.each(function(e){if(1===this.nodeType)if(C(t))for(o in t)Ce(this,o,t[o]);else Ce(this,t,j(this,n,e,this.getAttribute(t)))}):0 in this&&1==this[0].nodeType&&null!=(e=this[0].getAttribute(t))?e:l},removeAttr:function(e){return this.each(function(){1===this.nodeType&&e.split(\\" \\").forEach(function(e){Ce(this,e)},this)})},prop:function(t,n){return t=Y[t]||t,1 in arguments?this.each(function(e){this[t]=j(this,n,e,this[t])}):this[0]&&this[0][t]},removeProp:function(e){return e=Y[e]||e,this.each(function(){delete this[e]})},data:function(e,t){var n=\\"data-\\"+e.replace(H,\\"-$1\\").toLowerCase(),n=1 in arguments?this.attr(n,t):this.attr(n);return null!==n?Ae(n):l},val:function(t){return 0 in arguments?(null==t&&(t=\\"\\"),this.each(function(e){this.value=j(this,t,e,this.value)})):this[0]&&(this[0].multiple?c(this[0]).find(\\"option\\").filter(function(){return this.selected}).pluck(\\"value\\"):this[0].value)},offset:function(r){var e;return r?this.each(function(e){var t=c(this),e=j(this,r,e,t.offset()),n=t.offsetParent().offset(),e={top:e.top-n.top,left:e.left-n.left};\\"static\\"==t.css(\\"position\\")&&(e.position=\\"relative\\"),t.css(e)}):this.length?f.documentElement===this[0]||c.contains(f.documentElement,this[0])?{left:(e=this[0].getBoundingClientRect()).left+h.pageXOffset,top:e.top+h.pageYOffset,width:Math.round(e.width),height:Math.round(e.height)}:{top:0,left:0}:null},css:function(e,t){if(arguments.length<2){var n,r,i=this[0];if(\\"string\\"==typeof e)return i?i.style[s(e)]||getComputedStyle(i,\\"\\").getPropertyValue(e):void 0;if(m(e))return i?(n={},r=getComputedStyle(i,\\"\\"),c.each(e,function(e,t){n[t]=i.style[s(t)]||r.getPropertyValue(t)}),n):void 0}var a=\\"\\";if(\\"string\\"==S(e))t||0===t?a=N(e)+\\":\\"+Ee(e,t):this.each(function(){this.style.removeProperty(N(e))});else for(o in e)e[o]||0===e[o]?a+=N(o)+\\":\\"+Ee(o,e[o])+\\";\\":this.each(function(){this.style.removeProperty(N(o))});return this.each(function(){this.style.cssText+=\\";\\"+a})},index:function(e){return e?this.indexOf(c(e)[0]):this.parent().children().indexOf(this[0])},hasClass:function(e){return!!e&&i.some.call(this,function(e){return this.test(T(e))},we(e))},addClass:function(n){return n?this.each(function(e){var t;\\"className\\"in this&&(r=[],t=T(this),j(this,n,e,t).split(/\\\\s+/g).forEach(function(e){c(this).hasClass(e)||r.push(e)},this),r.length)&&T(this,t+(t?\\" \\":\\"\\")+r.join(\\" \\"))}):this},removeClass:function(t){return this.each(function(e){if(\\"className\\"in this){if(t===l)return T(this,\\"\\");r=T(this),j(this,t,e,r).split(/\\\\s+/g).forEach(function(e){r=r.replace(we(e),\\" \\")}),T(this,r.trim())}})},toggleClass:function(n,r){return n?this.each(function(e){var t=c(this);j(this,n,e,T(this)).split(/\\\\s+/g).forEach(function(e){(r===l?!t.hasClass(e):r)?t.addClass(e):t.removeClass(e)})}):this},scrollTop:function(e){var t;if(this.length)return t=\\"scrollTop\\"in this[0],e===l?t?this[0].scrollTop:this[0].pageYOffset:this.each(t?function(){this.scrollTop=e}:function(){this.scrollTo(this.scrollX,e)})},scrollLeft:function(e){var t;if(this.length)return t=\\"scrollLeft\\"in this[0],e===l?t?this[0].scrollLeft:this[0].pageXOffset:this.each(t?function(){this.scrollLeft=e}:function(){this.scrollTo(e,this.scrollY)})},position:function(){var e,t,n,r;if(this.length)return e=this[0],t=this.offsetParent(),n=this.offset(),r=z.test(t[0].nodeName)?{top:0,left:0}:t.offset(),n.top-=parseFloat(c(e).css(\\"margin-top\\"))||0,n.left-=parseFloat(c(e).css(\\"margin-left\\"))||0,r.top+=parseFloat(c(t[0]).css(\\"border-top-width\\"))||0,r.left+=parseFloat(c(t[0]).css(\\"border-left-width\\"))||0,{top:n.top-r.top,left:n.left-r.left}},offsetParent:function(){return this.map(function(){for(var e=this.offsetParent||f.body;e&&!z.test(e.nodeName)&&\\"static\\"==c(e).css(\\"position\\");)e=e.offsetParent;return e})}},c.fn.detach=c.fn.remove,[\\"width\\",\\"height\\"].forEach(function(r){var i=r.replace(/./,function(e){return e[0].toUpperCase()});c.fn[r]=function(t){var e,n=this[0];return t===l?ve(n)?n[\\"inner\\"+i]:be(n)?n.documentElement[\\"scroll\\"+i]:(e=this.offset())&&e[r]:this.each(function(e){(n=c(this)).css(r,j(this,t,e,n[r]()))})}}),[\\"after\\",\\"prepend\\",\\"before\\",\\"append\\"].forEach(function(t,o){var s=o%2;c.fn[t]=function(){var n,r,i=c.map(arguments,function(e){var t=[];return\\"array\\"==(n=S(e))?(e.forEach(function(e){return e.nodeType!==l?t.push(e):c.zepto.isZ(e)?t=t.concat(e.get()):void(t=t.concat(d.fragment(e)))}),t):\\"object\\"==n||null==e?e:d.fragment(e)}),a=1<this.length;return i.length<1?this:this.each(function(e,t){r=s?t:t.parentNode,t=0==o?t.nextSibling:1==o?t.firstChild:2==o?t:null;var n=c.contains(f.documentElement,r);i.forEach(function(e){if(a)e=e.cloneNode(!0);else if(!r)return c(e).remove();r.insertBefore(e,t),n&&function e(t,n){n(t);for(var r=0,i=t.childNodes.length;r<i;r++)e(t.childNodes[r],n)}(e,function(e){var t;null==e.nodeName||\\"SCRIPT\\"!==e.nodeName.toUpperCase()||e.type&&\\"text/javascript\\"!==e.type||e.src||(t=e.ownerDocument?e.ownerDocument.defaultView:h).eval.call(t,e.innerHTML)})})})},c.fn[s?t+\\"To\\":\\"insert\\"+(o?\\"Before\\":\\"After\\")]=function(e){return c(e)[t](this),this}}),d.Z.prototype=Se.prototype=c.fn,d.uniq=n,d.deserializeValue=Ae,c.zepto=d;var l,o,c,r,s,n,i,$,a,u,f,p,t,I,_,B,q,z,H,W,R,Z,V,J,X,U,d,G,Y,m,g,y,Q,K,ee,v,b,te,ne,re,ie,ae,oe,se,x,le,w,ce,E,ue,fe,pe,he,de,me,ge,ye,P,e=c;function S(e){return null==e?String(e):X[U.call(e)]||\\"object\\"}function k(e){return\\"function\\"==S(e)}function ve(e){return null!=e&&e==e.window}function be(e){return null!=e&&e.nodeType==e.DOCUMENT_NODE}function C(e){return\\"object\\"==S(e)}function A(e){return C(e)&&!ve(e)&&Object.getPrototypeOf(e)==Object.prototype}function xe(e){var t=!!e&&\\"length\\"in e&&e.length,n=c.type(e);return\\"function\\"!=n&&!ve(e)&&(\\"array\\"==n||0===t||\\"number\\"==typeof t&&0<t&&t-1 in e)}function N(e){return e.replace(/::/g,\\"/\\").replace(/([A-Z]+)([A-Z][a-z])/g,\\"$1_$2\\").replace(/([a-z\\\\d])([A-Z])/g,\\"$1_$2\\").replace(/_/g,\\"-\\").toLowerCase()}function we(e){return e in t?t[e]:t[e]=new RegExp(\\"(^|\\\\\\\\s)\\"+e+\\"(\\\\\\\\s|$)\\")}function Ee(e,t){return\\"number\\"!=typeof t||I[N(e)]?t:t+\\"px\\"}function Pe(e){return\\"children\\"in e?u.call(e.children):c.map(e.childNodes,function(e){if(1==e.nodeType)return e})}function Se(e,t){for(var n=e?e.length:0,r=0;r<n;r++)this[r]=e[r];this.length=n,this.selector=t||\\"\\"}function ke(e,t){return null==t?c(e):c(e).filter(t)}function j(e,t,n,r){return k(t)?t.call(e,n,r):t}function Ce(e,t,n){null==n?e.removeAttribute(t):e.setAttribute(t,n)}function T(e,t){var n=e.className||\\"\\",r=n&&n.baseVal!==l;if(t===l)return r?n.baseVal:n;r?n.baseVal=t:e.className=t}function Ae(t){try{return t&&(\\"true\\"==t||\\"false\\"!=t&&(\\"null\\"==t?null:+t+\\"\\"==t?+t:/^[\\\\[\\\\{]/.test(t)?c.parseJSON(t):t))}catch(e){return t}}function O(e){return\\"string\\"==typeof e}function L(e){return e._zid||(e._zid=Q++)}function Ne(e,t,n,r){var i,a;return(t=je(t)).ns&&(a=t.ns,i=new RegExp(\\"(?:^| )\\"+a.replace(\\" \\",\\" .* ?\\")+\\"(?: |$)\\")),(v[L(e)]||[]).filter(function(e){return e&&(!t.e||e.e==t.e)&&(!t.ns||i.test(e.ns))&&(!n||L(e.fn)===L(n))&&(!r||e.sel==r)})}function je(e){e=(\\"\\"+e).split(\\".\\");return{e:e[0],ns:e.slice(1).sort().join(\\" \\")}}function Te(e,t){return e.del&&!te&&e.e in ne||!!t}function Oe(e){return re[e]||te&&ne[e]||e}function Le(i,e,t,a,o,s,l){var n=L(i),c=v[n]||(v[n]=[]);e.split(/\\\\s/).forEach(function(e){if(\\"ready\\"==e)return g(document).ready(t);var n=je(e),r=(n.fn=t,n.sel=o,n.e in re&&(t=function(e){var t=e.relatedTarget;if(!t||t!==this&&!g.contains(this,t))return n.fn.apply(this,arguments)}),(n.del=s)||t);n.proxy=function(e){var t;if(!(e=De(e)).isImmediatePropagationStopped())return e.data=a,!1===(t=r.apply(i,e._args==y?[e]:[e].concat(e._args)))&&(e.preventDefault(),e.stopPropagation()),t},n.i=c.length,c.push(n),\\"addEventListener\\"in i&&i.addEventListener(Oe(n.e),n.proxy,Te(n,l))})}function Fe(t,e,n,r,i){var a=L(t);(e||\\"\\").split(/\\\\s/).forEach(function(e){Ne(t,e,n,r).forEach(function(e){delete v[a][e.i],\\"removeEventListener\\"in t&&t.removeEventListener(Oe(e.e),e.proxy,Te(e,i))})})}function De(r,i){return(i||!r.isDefaultPrevented)&&(i=i||r,g.each(se,function(e,t){var n=i[e];r[e]=function(){return this[t]=ie,n&&n.apply(i,arguments)},r[t]=ae}),r.timeStamp||(r.timeStamp=Date.now()),i.defaultPrevented!==y?i.defaultPrevented:\\"returnValue\\"in i?!1===i.returnValue:i.getPreventDefault&&i.getPreventDefault())&&(r.isDefaultPrevented=ie),r}function Me(e){var t,n={originalEvent:e};for(t in e)oe.test(t)||e[t]===y||(n[t]=e[t]);return De(n,e)}function F(e,t,n,r){if(e.global)return e=t||E,t=n,n=r,t=x.Event(t),x(e).trigger(t,n),!t.isDefaultPrevented()}function $e(e,t){var n=t.context;if(!1===t.beforeSend.call(n,e,t)||!1===F(t,n,\\"ajaxBeforeSend\\",[e,t]))return!1;F(t,n,\\"ajaxSend\\",[e,t])}function Ie(e,t,n,r){var i=n.context,a=\\"success\\";n.success.call(i,e,a,t),r&&r.resolveWith(i,[e,a,t]),F(n,i,\\"ajaxSuccess\\",[t,n,e]),_e(a,t,n)}function D(e,t,n,r,i){var a=r.context;r.error.call(a,n,t,e),i&&i.rejectWith(a,[n,t,e]),F(r,a,\\"ajaxError\\",[n,r,e||t]),_e(t,n,r)}function _e(e,t,n){var r=n.context;n.complete.call(r,t,e),F(n,r,\\"ajaxComplete\\",[t,n]),(e=n).global&&!--x.active&&F(e,null,\\"ajaxStop\\")}function M(){}function Be(e,t){return\\"\\"==t?e:(e+\\"&\\"+t).replace(/[&?]{1,2}/,\\"?\\")}function qe(e,t,n,r){return x.isFunction(t)&&(r=n,n=t,t=void 0),x.isFunction(n)||(r=n,n=void 0),{url:e,data:t,success:n,dataType:r}}h.Zepto=e,void 0===h.$&&(h.$=e),g=e,Q=1,K=Array.prototype.slice,ee=g.isFunction,v={},b={},te=\\"onfocusin\\"in h,ne={focus:\\"focusin\\",blur:\\"focusout\\"},re={mouseenter:\\"mouseover\\",mouseleave:\\"mouseout\\"},b.click=b.mousedown=b.mouseup=b.mousemove=\\"MouseEvents\\",g.event={add:Le,remove:Fe},g.proxy=function(e,t){var n,r=2 in arguments&&K.call(arguments,2);if(ee(e))return(n=function(){return e.apply(t,r?r.concat(K.call(arguments)):arguments)})._zid=L(e),n;if(O(t))return r?(r.unshift(e[t],e),g.proxy.apply(null,r)):g.proxy(e[t],e);throw new TypeError(\\"expected function\\")},g.fn.bind=function(e,t,n){return this.on(e,t,n)},g.fn.unbind=function(e,t){return this.off(e,t)},g.fn.one=function(e,t,n,r){return this.on(e,t,n,r,1)},ie=function(){return!0},ae=function(){return!1},oe=/^([A-Z]|returnValue$|layer[XY]$|webkitMovement[XY]$)/,se={preventDefault:\\"isDefaultPrevented\\",stopImmediatePropagation:\\"isImmediatePropagationStopped\\",stopPropagation:\\"isPropagationStopped\\"},g.fn.delegate=function(e,t,n){return this.on(t,e,n)},g.fn.undelegate=function(e,t,n){return this.off(t,e,n)},g.fn.live=function(e,t){return g(document.body).delegate(this.selector,e,t),this},g.fn.die=function(e,t){return g(document.body).undelegate(this.selector,e,t),this},g.fn.on=function(t,i,n,a,o){var s,l,r=this;return t&&!O(t)?(g.each(t,function(e,t){r.on(e,i,n,t,o)}),r):(O(i)||ee(a)||!1===a||(a=n,n=i,i=y),a!==y&&!1!==n||(a=n,n=y),!1===a&&(a=ae),r.each(function(e,r){o&&(s=function(e){return Fe(r,e.type,a),a.apply(this,arguments)}),Le(r,t,a,n,i,(l=i?function(e){var t,n=g(e.target).closest(i,r).get(0);if(n&&n!==r)return t=g.extend(Me(e),{currentTarget:n,liveFired:r}),(s||a).apply(n,[t].concat(K.call(arguments,1)))}:l)||s)}))},g.fn.off=function(e,n,t){var r=this;return e&&!O(e)?(g.each(e,function(e,t){r.off(e,n,t)}),r):(O(n)||ee(t)||!1===t||(t=n,n=y),!1===t&&(t=ae),r.each(function(){Fe(this,e,t,n)}))},g.fn.trigger=function(e,t){return(e=O(e)||g.isPlainObject(e)?g.Event(e):De(e))._args=t,this.each(function(){e.type in ne&&\\"function\\"==typeof this[e.type]?this[e.type]():\\"dispatchEvent\\"in this?this.dispatchEvent(e):g(this).triggerHandler(e,t)})},g.fn.triggerHandler=function(n,r){var i,a;return this.each(function(e,t){(i=Me(O(n)?g.Event(n):n))._args=r,i.target=t,g.each(Ne(t,n.type||n),function(e,t){if(a=t.proxy(i),i.isImmediatePropagationStopped())return!1})}),a},\\"focusin focusout focus blur load resize scroll unload click dblclick mousedown mouseup mousemove mouseover mouseout mouseenter mouseleave change select keydown keypress keyup error\\".split(\\" \\").forEach(function(t){g.fn[t]=function(e){return 0 in arguments?this.bind(t,e):this.trigger(t)}}),g.Event=function(e,t){O(e)||(e=(t=e).type);var n=document.createEvent(b[e]||\\"Events\\"),r=!0;if(t)for(var i in t)\\"bubbles\\"==i?r=!!t[i]:n[i]=t[i];return n.initEvent(e,r,!0),De(n)},x=e,ce=+new Date,E=h.document,ue=/<script\\\\b[^<]*(?:(?!<\\\\/script>)<[^<]*)*<\\\\/script>/gi,fe=/^(?:text|application)\\\\/javascript/i,pe=/^(?:text|application)\\\\/xml/i,he=\\"application/json\\",de=\\"text/html\\",me=/^\\\\s*$/,(ge=E.createElement(\\"a\\")).href=h.location.href,x.active=0,x.ajaxJSONP=function(n,r){var e,i,a,o,s,t,l,c;return\\"type\\"in n?(e=n.jsonpCallback,i=(x.isFunction(e)?e():e)||\\"Zepto\\"+ce++,a=E.createElement(\\"script\\"),o=h[i],l={abort:t=function(e){x(a).triggerHandler(\\"error\\",e||\\"abort\\")}},r&&r.promise(l),x(a).on(\\"load error\\",function(e,t){clearTimeout(c),x(a).off().remove(),\\"error\\"!=e.type&&s?Ie(s[0],l,n,r):D(null,t||\\"error\\",l,n,r),h[i]=o,s&&x.isFunction(o)&&o(s[0]),o=s=void 0}),!1===$e(l,n)?t(\\"abort\\"):(h[i]=function(){s=arguments},a.src=n.url.replace(/\\\\?(.+)=\\\\?/,\\"?$1=\\"+i),E.head.appendChild(a),0<n.timeout&&(c=setTimeout(function(){t(\\"timeout\\")},n.timeout))),l):x.ajax(n)},x.ajaxSettings={type:\\"GET\\",beforeSend:M,success:M,error:M,complete:M,context:null,global:!0,xhr:function(){return new h.XMLHttpRequest},accepts:{script:\\"text/javascript, application/javascript, application/x-javascript\\",json:he,xml:\\"application/xml, text/xml\\",html:de,text:\\"text/plain\\"},crossDomain:!1,timeout:0,processData:!0,cache:!0,dataFilter:M},x.ajax=function(e){var s=x.extend({},e||{}),l=x.Deferred&&x.Deferred();for(le in x.ajaxSettings)void 0===s[le]&&(s[le]=x.ajaxSettings[le]);(t=s).global&&0==x.active++&&F(t,null,\\"ajaxStart\\"),s.crossDomain||((t=E.createElement(\\"a\\")).href=s.url,t.href=t.href,s.crossDomain=ge.protocol+\\"//\\"+ge.host!=t.protocol+\\"//\\"+t.host),s.url||(s.url=h.location.toString()),-1<(t=s.url.indexOf(\\"#\\"))&&(s.url=s.url.slice(0,t)),(t=s).processData&&t.data&&\\"string\\"!=x.type(t.data)&&(t.data=x.param(t.data,t.traditional)),!t.data||t.type&&\\"GET\\"!=t.type.toUpperCase()&&\\"jsonp\\"!=t.dataType||(t.url=Be(t.url,t.data),t.data=void 0);var c=s.dataType,t=/\\\\?.+=\\\\?/.test(s.url);if(t&&(c=\\"jsonp\\"),!1!==s.cache&&(e&&!0===e.cache||\\"script\\"!=c&&\\"jsonp\\"!=c)||(s.url=Be(s.url,\\"_=\\"+Date.now())),\\"jsonp\\"==c)return t||(s.url=Be(s.url,s.jsonp?s.jsonp+\\"=?\\":!1===s.jsonp?\\"\\":\\"callback=?\\")),x.ajaxJSONP(s,l);function n(e,t){r[e.toLowerCase()]=[e,t]}var u,e=s.accepts[c],r={},f=/^([\\\\w-]+:)\\\\/\\\\//.test(s.url)?RegExp.$1:h.location.protocol,p=s.xhr(),i=p.setRequestHeader;if(l&&l.promise(p),s.crossDomain||n(\\"X-Requested-With\\",\\"XMLHttpRequest\\"),n(\\"Accept\\",e||\\"*/*\\"),(e=s.mimeType||e)&&(-1<e.indexOf(\\",\\")&&(e=e.split(\\",\\",2)[0]),p.overrideMimeType)&&p.overrideMimeType(e),(s.contentType||!1!==s.contentType&&s.data&&\\"GET\\"!=s.type.toUpperCase())&&n(\\"Content-Type\\",s.contentType||\\"application/x-www-form-urlencoded\\"),s.headers)for(w in s.headers)n(w,s.headers[w]);if(p.setRequestHeader=n,!(p.onreadystatechange=function(){if(4==p.readyState){p.onreadystatechange=M,clearTimeout(u);var e,t=!1;if(200<=p.status&&p.status<300||304==p.status||0==p.status&&\\"file:\\"==f){if(c=c||(o=(o=s.mimeType||p.getResponseHeader(\\"content-type\\"))&&o.split(\\";\\",2)[0])&&(o==de?\\"html\\":o==he?\\"json\\":fe.test(o)?\\"script\\":pe.test(o)&&\\"xml\\")||\\"text\\",\\"arraybuffer\\"==p.responseType||\\"blob\\"==p.responseType)e=p.response;else{e=p.responseText;try{n=e,r=c,e=(i=s).dataFilter==M?n:(a=i.context,i.dataFilter.call(a,n,r)),\\"script\\"==c?(0,eval)(e):\\"xml\\"==c?e=p.responseXML:\\"json\\"==c&&(e=me.test(e)?null:x.parseJSON(e))}catch(e){t=e}if(t)return D(t,\\"parsererror\\",p,s,l)}Ie(e,p,s,l)}else D(p.statusText||null,p.status?\\"error\\":\\"abort\\",p,s,l)}var n,r,i,a,o})===$e(p,s))p.abort(),D(null,\\"abort\\",p,s,l);else{t=!(\\"async\\"in s)||s.async;if(p.open(s.type,s.url,t,s.username,s.password),s.xhrFields)for(w in s.xhrFields)p[w]=s.xhrFields[w];for(w in r)i.apply(p,r[w]);0<s.timeout&&(u=setTimeout(function(){p.onreadystatechange=M,p.abort(),D(null,\\"timeout\\",p,s,l)},s.timeout)),p.send(s.data||null)}return p},x.get=function(){return x.ajax(qe.apply(null,arguments))},x.post=function(){var e=qe.apply(null,arguments);return e.type=\\"POST\\",x.ajax(e)},x.getJSON=function(){var e=qe.apply(null,arguments);return e.dataType=\\"json\\",x.ajax(e)},x.fn.load=function(e,t,n){var r,i,a,o;return this.length&&(r=this,i=e.split(/\\\\s/),e=qe(e,t,n),o=e.success,1<i.length&&(e.url=i[0],a=i[1]),e.success=function(e){r.html(a?x(\\"<div>\\").html(e.replace(ue,\\"\\")).find(a):e),o&&o.apply(r,arguments)},x.ajax(e)),this},ye=encodeURIComponent,x.param=function(e,t){var n=[];return n.add=function(e,t){null==(t=x.isFunction(t)?t():t)&&(t=\\"\\"),this.push(ye(e)+\\"=\\"+ye(t))},function n(r,e,i,a){var o,s=x.isArray(e),l=x.isPlainObject(e);x.each(e,function(e,t){o=x.type(t),a&&(e=i?a:a+\\"[\\"+(l||\\"object\\"==o||\\"array\\"==o?e:\\"\\")+\\"]\\"),!a&&s?r.add(t.name,t.value):\\"array\\"==o||!i&&\\"object\\"==o?n(r,t,i,e):r.add(e,t)})}(n,e,t),n.join(\\"&\\").replace(/%20/g,\\"+\\")},(P=e).fn.serializeArray=function(){function n(e){if(e.forEach)return e.forEach(n);t.push({name:r,value:e})}var r,i,t=[];return this[0]&&P.each(this[0].elements,function(e,t){i=t.type,(r=t.name)&&\\"fieldset\\"!=t.nodeName.toLowerCase()&&!t.disabled&&\\"submit\\"!=i&&\\"reset\\"!=i&&\\"button\\"!=i&&\\"file\\"!=i&&(\\"radio\\"!=i&&\\"checkbox\\"!=i||t.checked)&&n(P(t).val())}),t},P.fn.serialize=function(){var t=[];return this.serializeArray().forEach(function(e){t.push(encodeURIComponent(e.name)+\\"=\\"+encodeURIComponent(e.value))}),t.join(\\"&\\")},P.fn.submit=function(e){var t;return 0 in arguments?this.bind(\\"submit\\",e):this.length&&(t=P.Event(\\"submit\\"),this.eq(0).trigger(t),t.isDefaultPrevented()||this.get(0).submit()),this};try{getComputedStyle(void 0)}catch(e){var ze=getComputedStyle;h.getComputedStyle=function(e,t){try{return ze(e,t)}catch(e){return null}}}return e});var _self=\\"undefined\\"!=typeof window?window:\\"undefined\\"!=typeof WorkerGlobalScope&&self instanceof WorkerGlobalScope?self:{},Prism=function(){var e,s=/\\\\blang(?:uage)?-(\\\\w+)\\\\b/i,t=0,C=_self.Prism={util:{encode:function(e){return e instanceof i?new i(e.type,C.util.encode(e.content),e.alias):\\"Array\\"===C.util.type(e)?e.map(C.util.encode):e.replace(/&/g,\\"&amp;\\").replace(/</g,\\"&lt;\\").replace(/\\\\u00a0/g,\\" \\")},type:function(e){return Object.prototype.toString.call(e).match(/\\\\[object (\\\\w+)\\\\]/)[1]},objId:function(e){return e.__id||Object.defineProperty(e,\\"__id\\",{value:++t}),e.__id},clone:function(e){switch(C.util.type(e)){case\\"Object\\":var t,n={};for(t in e)e.hasOwnProperty(t)&&(n[t]=C.util.clone(e[t]));return n;case\\"Array\\":return e.map&&e.map(function(e){return C.util.clone(e)})}return e}},languages:{extend:function(e,t){var n,r=C.util.clone(C.languages[e]);for(n in t)r[n]=t[n];return r},insertBefore:function(n,e,t,r){var i=(r=r||C.languages)[n];if(2==arguments.length){for(var a in t=e)t.hasOwnProperty(a)&&(i[a]=t[a]);return i}var o,s={};for(o in i)if(i.hasOwnProperty(o)){if(o==e)for(var a in t)t.hasOwnProperty(a)&&(s[a]=t[a]);s[o]=i[o]}return C.languages.DFS(C.languages,function(e,t){t===r[n]&&e!=n&&(this[e]=s)}),r[n]=s},DFS:function(e,t,n,r){for(var i in r=r||{},e)e.hasOwnProperty(i)&&(t.call(e,i,e[i],n||i),\\"Object\\"!==C.util.type(e[i])||r[C.util.objId(e[i])]?\\"Array\\"!==C.util.type(e[i])||r[C.util.objId(e[i])]||(r[C.util.objId(e[i])]=!0,C.languages.DFS(e[i],t,i,r)):(r[C.util.objId(e[i])]=!0,C.languages.DFS(e[i],t,null,r)))}},plugins:{},highlightAll:function(e,t){var n={callback:t,selector:'code[class*=\\"language-\\"], [class*=\\"language-\\"] code, code[class*=\\"lang-\\"], [class*=\\"lang-\\"] code'};C.hooks.run(\\"before-highlightall\\",n);for(var r,i=n.elements||document.querySelectorAll(n.selector),a=0;r=i[a++];)C.highlightElement(r,!0===e,n.callback)},highlightElement:function(e,t,n){for(var r,i=e;i&&!s.test(i.className);)i=i.parentNode;i&&(a=(i.className.match(s)||[,\\"\\"])[1].toLowerCase(),r=C.languages[a]),e.className=e.className.replace(s,\\"\\").replace(/\\\\s+/g,\\" \\")+\\" language-\\"+a,i=e.parentNode,/pre/i.test(i.nodeName)&&(i.className=i.className.replace(s,\\"\\").replace(/\\\\s+/g,\\" \\")+\\" language-\\"+a);var a,o={element:e,language:a,grammar:r,code:e.textContent};C.hooks.run(\\"before-sanity-check\\",o),o.code&&o.grammar?(C.hooks.run(\\"before-highlight\\",o),t&&_self.Worker?((a=new Worker(C.filename)).onmessage=function(e){o.highlightedCode=e.data,C.hooks.run(\\"before-insert\\",o),o.element.innerHTML=o.highlightedCode,n&&n.call(o.element),C.hooks.run(\\"after-highlight\\",o),C.hooks.run(\\"complete\\",o)},a.postMessage(JSON.stringify({language:o.language,code:o.code,immediateClose:!0}))):(o.highlightedCode=C.highlight(o.code,o.grammar,o.language),C.hooks.run(\\"before-insert\\",o),o.element.innerHTML=o.highlightedCode,n&&n.call(e),C.hooks.run(\\"after-highlight\\",o),C.hooks.run(\\"complete\\",o))):(o.code&&(o.element.textContent=o.code),C.hooks.run(\\"complete\\",o))},highlight:function(e,t,n){e=C.tokenize(e,t);return i.stringify(C.util.encode(e),n)},tokenize:function(e,t){var n=C.Token,r=[e],i=t.rest;if(i){for(var a in i)t[a]=i[a];delete t.rest}e:for(var a in t)if(t.hasOwnProperty(a)&&t[a])for(var o=t[a],o=\\"Array\\"===C.util.type(o)?o:[o],s=0;s<o.length;++s){var l,c=(d=o[s]).inside,u=!!d.lookbehind,f=!!d.greedy,p=0,h=d.alias;f&&!d.pattern.global&&(l=d.pattern.toString().match(/[imuy]*$/)[0],d.pattern=RegExp(d.pattern.source,l+\\"g\\"));for(var d=d.pattern||d,m=0,g=0;m<r.length;g+=r[m].length,++m){var y=r[m];if(r.length>e.length)break e;if(!(y instanceof n)){d.lastIndex=0;var v,b=d.exec(y),x=1;if(!b&&f&&m!=r.length-1){if(d.lastIndex=g,!(b=d.exec(e)))break;for(var w=b.index+(u?b[1].length:0),E=b.index+b[0].length,P=m,S=g,k=r.length;P<k&&S<E;++P)(S+=r[P].length)<=w&&(++m,g=S);if(r[m]instanceof n||r[P-1].greedy)continue;x=P-m,y=e.slice(g,S),b.index-=g}b&&(u&&(p=b[1].length),E=(w=b.index+p)+(b=b[0].slice(p)).length,v=y.slice(0,w),y=y.slice(E),x=[m,x],v&&x.push(v),v=new n(a,c?C.tokenize(b,c):b,h,b,f),x.push(v),y&&x.push(y),Array.prototype.splice.apply(r,x))}}}return r},hooks:{all:{},add:function(e,t){var n=C.hooks.all;n[e]=n[e]||[],n[e].push(t)},run:function(e,t){var n=C.hooks.all[e];if(n&&n.length)for(var r,i=0;r=n[i++];)r(t)}}},i=C.Token=function(e,t,n,r,i){this.type=e,this.content=t,this.alias=n,this.length=0|(r||\\"\\").length,this.greedy=!!i};return(i.stringify=function(t,n,e){var r;return\\"string\\"==typeof t?t:\\"Array\\"===C.util.type(t)?t.map(function(e){return i.stringify(e,n,t)}).join(\\"\\"):(\\"comment\\"==(r={type:t.type,content:i.stringify(t.content,n,e),tag:\\"span\\",classes:[\\"token\\",t.type],attributes:{},language:n,parent:e}).type&&(r.attributes.spellcheck=\\"true\\"),t.alias&&(e=\\"Array\\"===C.util.type(t.alias)?t.alias:[t.alias],Array.prototype.push.apply(r.classes,e)),C.hooks.run(\\"wrap\\",r),e=Object.keys(r.attributes).map(function(e){return e+'=\\"'+(r.attributes[e]||\\"\\").replace(/\\"/g,\\"&quot;\\")+'\\"'}).join(\\" \\"),\\"<\\"+r.tag+' class=\\"'+r.classes.join(\\" \\")+'\\"'+(e?\\" \\"+e:\\"\\")+\\">\\"+r.content+\\"</\\"+r.tag+\\">\\")},_self.document)?(e=document.currentScript||[].slice.call(document.getElementsByTagName(\\"script\\")).pop())&&(C.filename=e.src,document.addEventListener)&&!e.hasAttribute(\\"data-manual\\")&&(\\"loading\\"!==document.readyState?window.requestAnimationFrame?window.requestAnimationFrame(C.highlightAll):window.setTimeout(C.highlightAll,16):document.addEventListener(\\"DOMContentLoaded\\",C.highlightAll)):_self.addEventListener&&_self.addEventListener(\\"message\\",function(e){var e=JSON.parse(e.data),t=e.language,n=e.code,e=e.immediateClose;_self.postMessage(C.highlight(n,C.languages[t],t)),e&&_self.close()},!1),_self.Prism}();\\"undefined\\"!=typeof module&&module.exports&&(module.exports=Prism),\\"undefined\\"!=typeof global&&(global.Prism=Prism),Prism.languages.markup={comment:/<!--[\\\\w\\\\W]*?-->/,prolog:/<\\\\?[\\\\w\\\\W]+?\\\\?>/,doctype:/<!DOCTYPE[\\\\w\\\\W]+?>/i,cdata:/<!\\\\[CDATA\\\\[[\\\\w\\\\W]*?]]>/i,tag:{pattern:/<\\\\/?(?!\\\\d)[^\\\\s>\\\\/=$<]+(?:\\\\s+[^\\\\s>\\\\/=]+(?:=(?:(\\"|')(?:\\\\\\\\\\\\1|\\\\\\\\?(?!\\\\1)[\\\\w\\\\W])*\\\\1|[^\\\\s'\\">=]+))?)*\\\\s*\\\\/?>/i,inside:{tag:{pattern:/^<\\\\/?[^\\\\s>\\\\/]+/i,inside:{punctuation:/^<\\\\/?/,namespace:/^[^\\\\s>\\\\/:]+:/}},\\"attr-value\\":{pattern:/=(?:('|\\")[\\\\w\\\\W]*?(\\\\1)|[^\\\\s>]+)/i,inside:{punctuation:/[=>\\"']/}},punctuation:/\\\\/?>/,\\"attr-name\\":{pattern:/[^\\\\s>\\\\/]+/,inside:{namespace:/^[^\\\\s>\\\\/:]+:/}}}},entity:/&#?[\\\\da-z]{1,8};/i},Prism.hooks.add(\\"wrap\\",function(e){\\"entity\\"===e.type&&(e.attributes.title=e.content.replace(/&amp;/,\\"&\\"))}),Prism.languages.xml=Prism.languages.markup,Prism.languages.html=Prism.languages.markup,Prism.languages.mathml=Prism.languages.markup,Prism.languages.svg=Prism.languages.markup,Prism.languages.css={comment:/\\\\/\\\\*[\\\\w\\\\W]*?\\\\*\\\\//,atrule:{pattern:/@[\\\\w-]+?.*?(;|(?=\\\\s*\\\\{))/i,inside:{rule:/@[\\\\w-]+/}},url:/url\\\\((?:([\\"'])(\\\\\\\\(?:\\\\r\\\\n|[\\\\w\\\\W])|(?!\\\\1)[^\\\\\\\\\\\\r\\\\n])*\\\\1|.*?)\\\\)/i,selector:/[^\\\\{\\\\}\\\\s][^\\\\{\\\\};]*?(?=\\\\s*\\\\{)/,string:{pattern:/(\\"|')(\\\\\\\\(?:\\\\r\\\\n|[\\\\w\\\\W])|(?!\\\\1)[^\\\\\\\\\\\\r\\\\n])*\\\\1/,greedy:!0},property:/(\\\\b|\\\\B)[\\\\w-]+(?=\\\\s*:)/i,important:/\\\\B!important\\\\b/i,function:/[-a-z0-9]+(?=\\\\()/i,punctuation:/[(){};:]/},Prism.languages.css.atrule.inside.rest=Prism.util.clone(Prism.languages.css),Prism.languages.markup&&(Prism.languages.insertBefore(\\"markup\\",\\"tag\\",{style:{pattern:/(<style[\\\\w\\\\W]*?>)[\\\\w\\\\W]*?(?=<\\\\/style>)/i,lookbehind:!0,inside:Prism.languages.css,alias:\\"language-css\\"}}),Prism.languages.insertBefore(\\"inside\\",\\"attr-value\\",{\\"style-attr\\":{pattern:/\\\\s*style=(\\"|').*?\\\\1/i,inside:{\\"attr-name\\":{pattern:/^\\\\s*style/i,inside:Prism.languages.markup.tag.inside},punctuation:/^\\\\s*=\\\\s*['\\"]|['\\"]\\\\s*$/,\\"attr-value\\":{pattern:/.+/i,inside:Prism.languages.css}},alias:\\"language-css\\"}},Prism.languages.markup.tag)),Prism.languages.clike={comment:[{pattern:/(^|[^\\\\\\\\])\\\\/\\\\*[\\\\w\\\\W]*?\\\\*\\\\//,lookbehind:!0},{pattern:/(^|[^\\\\\\\\:])\\\\/\\\\/.*/,lookbehind:!0}],string:{pattern:/([\\"'])(\\\\\\\\(?:\\\\r\\\\n|[\\\\s\\\\S])|(?!\\\\1)[^\\\\\\\\\\\\r\\\\n])*\\\\1/,greedy:!0},\\"class-name\\":{pattern:/((?:\\\\b(?:class|interface|extends|implements|trait|instanceof|new)\\\\s+)|(?:catch\\\\s+\\\\())[a-z0-9_\\\\.\\\\\\\\]+/i,lookbehind:!0,inside:{punctuation:/(\\\\.|\\\\\\\\)/}},keyword:/\\\\b(if|else|while|do|for|return|in|instanceof|function|new|try|throw|catch|finally|null|break|continue)\\\\b/,boolean:/\\\\b(true|false)\\\\b/,function:/[a-z0-9_]+(?=\\\\()/i,number:/\\\\b-?(?:0x[\\\\da-f]+|\\\\d*\\\\.?\\\\d+(?:e[+-]?\\\\d+)?)\\\\b/i,operator:/--?|\\\\+\\\\+?|!=?=?|<=?|>=?|==?=?|&&?|\\\\|\\\\|?|\\\\?|\\\\*|\\\\/|~|\\\\^|%/,punctuation:/[{}[\\\\];(),.:]/},Prism.languages.javascript=Prism.languages.extend(\\"clike\\",{keyword:/\\\\b(as|async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|extends|finally|for|from|function|get|if|implements|import|in|instanceof|interface|let|new|null|of|package|private|protected|public|return|set|static|super|switch|this|throw|try|typeof|var|void|while|with|yield)\\\\b/,number:/\\\\b-?(0x[\\\\dA-Fa-f]+|0b[01]+|0o[0-7]+|\\\\d*\\\\.?\\\\d+([Ee][+-]?\\\\d+)?|NaN|Infinity)\\\\b/,function:/[_$a-zA-Z\\\\xA0-\\\\uFFFF][_$a-zA-Z0-9\\\\xA0-\\\\uFFFF]*(?=\\\\()/i,operator:/--?|\\\\+\\\\+?|!=?=?|<=?|>=?|==?=?|&&?|\\\\|\\\\|?|\\\\?|\\\\*\\\\*?|\\\\/|~|\\\\^|%|\\\\.{3}/}),Prism.languages.insertBefore(\\"javascript\\",\\"keyword\\",{regex:{pattern:/(^|[^\\\\/])\\\\/(?!\\\\/)(\\\\[.+?]|\\\\\\\\.|[^\\\\/\\\\\\\\\\\\r\\\\n])+\\\\/[gimyu]{0,5}(?=\\\\s*($|[\\\\r\\\\n,.;})]))/,lookbehind:!0,greedy:!0}}),Prism.languages.insertBefore(\\"javascript\\",\\"string\\",{\\"template-string\\":{pattern:/\`(?:\\\\\\\\\\\\\\\\|\\\\\\\\?[^\\\\\\\\])*?\`/,greedy:!0,inside:{interpolation:{pattern:/\\\\$\\\\{[^}]+\\\\}/,inside:{\\"interpolation-punctuation\\":{pattern:/^\\\\$\\\\{|\\\\}$/,alias:\\"punctuation\\"},rest:Prism.languages.javascript}},string:/[\\\\s\\\\S]+/}}}),Prism.languages.markup&&Prism.languages.insertBefore(\\"markup\\",\\"tag\\",{script:{pattern:/(<script[\\\\w\\\\W]*?>)[\\\\w\\\\W]*?(?=<\\\\/script>)/i,lookbehind:!0,inside:Prism.languages.javascript,alias:\\"language-javascript\\"}}),Prism.languages.js=Prism.languages.javascript,!function(){function n(e,t){return Array.prototype.slice.call((t||document).querySelectorAll(e))}function u(e,t){return t=\\" \\"+t+\\" \\",-1<(\\" \\"+e.className+\\" \\").replace(/[\\\\n\\\\t]/g,\\" \\").indexOf(t)}function r(e,t,n){for(var r=t.replace(/\\\\s+/g,\\"\\").split(\\",\\"),i=+e.getAttribute(\\"data-line-offset\\")||0,a=(f()?parseInt:parseFloat)(getComputedStyle(e).lineHeight),o=0;l=r[o++];){var s=+(l=l.split(\\"-\\"))[0],l=+l[1]||s,c=document.createElement(\\"div\\");c.textContent=Array(l-s+2).join(\\" \\\\n\\"),c.setAttribute(\\"aria-hidden\\",\\"true\\"),c.className=(n||\\"\\")+\\" line-highlight\\",u(e,\\"line-numbers\\")||(c.setAttribute(\\"data-start\\",s),s<l&&c.setAttribute(\\"data-end\\",l)),c.style.top=(s-i-1)*a+\\"px\\",(!u(e,\\"line-numbers\\")&&e.querySelector(\\"code\\")||e).appendChild(c)}}function i(){var e=location.hash.slice(1),t=(n(\\".temporary.line-highlight\\").forEach(function(e){e.parentNode.removeChild(e)}),(e.match(/\\\\.([\\\\d,-]+)$/)||[,\\"\\"])[1]);t&&!document.getElementById(e)&&(e=e.slice(0,e.lastIndexOf(\\".\\")),e=document.getElementById(e))&&(e.hasAttribute(\\"data-line\\")||e.setAttribute(\\"data-line\\",\\"\\"),r(e,t,\\"temporary \\"),document.querySelector(\\".temporary.line-highlight\\").scrollIntoView())}var f,a,t;\\"undefined\\"!=typeof self&&self.Prism&&self.document&&document.querySelector&&(f=function(){var e;return void 0===t&&((e=document.createElement(\\"div\\")).style.fontSize=\\"13px\\",e.style.lineHeight=\\"1.5\\",e.style.padding=0,e.style.border=0,e.innerHTML=\\"&nbsp;<br />&nbsp;\\",document.body.appendChild(e),t=38===e.offsetHeight,document.body.removeChild(e)),t},a=0,Prism.hooks.add(\\"complete\\",function(e){var e=e.element.parentNode,t=e&&e.getAttribute(\\"data-line\\");e&&t&&/pre/i.test(e.nodeName)&&(clearTimeout(a),n(\\".line-highlight\\",e).forEach(function(e){e.parentNode.removeChild(e)}),r(e,t),a=setTimeout(i,1))}),window.addEventListener)&&window.addEventListener(\\"hashchange\\",i)}(),\\"undefined\\"!=typeof self&&self.Prism&&self.document&&Prism.hooks.add(\\"complete\\",function(e){var t,n,r;e.code&&(n=/\\\\s*\\\\bline-numbers\\\\b\\\\s*/,t=e.element.parentNode)&&/pre/i.test(t.nodeName)&&(n.test(t.className)||n.test(e.element.className))&&!e.element.querySelector(\\".line-numbers-rows\\")&&(n.test(e.element.className)&&(e.element.className=e.element.className.replace(n,\\"\\")),n.test(t.className)||(t.className+=\\" line-numbers\\"),n=(n=e.code.match(/\\\\n(?!$)/g))?n.length+1:1,n=(n=new Array(n+1)).join(\\"<span></span>\\"),(r=document.createElement(\\"span\\")).setAttribute(\\"aria-hidden\\",\\"true\\"),r.className=\\"line-numbers-rows\\",r.innerHTML=n,t.hasAttribute(\\"data-start\\")&&(t.style.counterReset=\\"linenumber \\"+(parseInt(t.getAttribute(\\"data-start\\"),10)-1)),e.element.appendChild(r))}),!function(){var t,i,a,e,n;\\"undefined\\"!=typeof self&&self.Prism&&self.document&&(t=[],i={},a=function(){},Prism.plugins.toolbar={},e=Prism.plugins.toolbar.registerButton=function(e,n){t.push(i[e]=\\"function\\"==typeof n?n:function(e){var t;return\\"function\\"==typeof n.onClick?((t=document.createElement(\\"button\\")).type=\\"button\\",t.addEventListener(\\"click\\",function(){n.onClick.call(this,e)})):\\"string\\"==typeof n.url?(t=document.createElement(\\"a\\")).href=n.url:t=document.createElement(\\"span\\"),t.textContent=n.text,t})},n=Prism.plugins.toolbar.hook=function(n){var r,e=n.element.parentNode;e&&/pre/i.test(e.nodeName)&&!e.classList.contains(\\"code-toolbar\\")&&(e.classList.add(\\"code-toolbar\\"),(r=document.createElement(\\"div\\")).classList.add(\\"toolbar\\"),(t=document.body.hasAttribute(\\"data-toolbar-order\\")?document.body.getAttribute(\\"data-toolbar-order\\").split(\\",\\").map(function(e){return i[e]||a}):t).forEach(function(e){var t,e=e(n);e&&((t=document.createElement(\\"div\\")).classList.add(\\"toolbar-item\\"),t.appendChild(e),r.appendChild(t))}),e.appendChild(r))},e(\\"label\\",function(e){e=e.element.parentNode;if(e&&/pre/i.test(e.nodeName)&&e.hasAttribute(\\"data-label\\")){var t,n,r=e.getAttribute(\\"data-label\\");try{n=document.querySelector(\\"template#\\"+r)}catch(e){}return n?t=n.content:(e.hasAttribute(\\"data-url\\")?(t=document.createElement(\\"a\\")).href=e.getAttribute(\\"data-url\\"):t=document.createElement(\\"span\\"),t.textContent=r),t}}),Prism.hooks.add(\\"complete\\",n))}(),!function(){if(\\"undefined\\"!=typeof self&&self.Prism&&self.document){if(!Prism.plugins.toolbar)return console.warn(\\"Show Languages plugin loaded before Toolbar plugin.\\");var n={html:\\"HTML\\",xml:\\"XML\\",svg:\\"SVG\\",mathml:\\"MathML\\",css:\\"CSS\\",clike:\\"C-like\\",javascript:\\"JavaScript\\",abap:\\"ABAP\\",actionscript:\\"ActionScript\\",apacheconf:\\"Apache Configuration\\",apl:\\"APL\\",applescript:\\"AppleScript\\",asciidoc:\\"AsciiDoc\\",aspnet:\\"ASP.NET (C#)\\",autoit:\\"AutoIt\\",autohotkey:\\"AutoHotkey\\",basic:\\"BASIC\\",csharp:\\"C#\\",cpp:\\"C++\\",coffeescript:\\"CoffeeScript\\",\\"css-extras\\":\\"CSS Extras\\",fsharp:\\"F#\\",glsl:\\"GLSL\\",graphql:\\"GraphQL\\",http:\\"HTTP\\",inform7:\\"Inform 7\\",json:\\"JSON\\",latex:\\"LaTeX\\",livescript:\\"LiveScript\\",lolcode:\\"LOLCODE\\",matlab:\\"MATLAB\\",mel:\\"MEL\\",nasm:\\"NASM\\",nginx:\\"nginx\\",nsis:\\"NSIS\\",objectivec:\\"Objective-C\\",ocaml:\\"OCaml\\",parigp:\\"PARI/GP\\",php:\\"PHP\\",\\"php-extras\\":\\"PHP Extras\\",powershell:\\"PowerShell\\",properties:\\".properties\\",protobuf:\\"Protocol Buffers\\",jsx:\\"React JSX\\",rest:\\"reST (reStructuredText)\\",sas:\\"SAS\\",sass:\\"Sass (Sass)\\",scss:\\"Sass (Scss)\\",sql:\\"SQL\\",typescript:\\"TypeScript\\",vhdl:\\"VHDL\\",vim:\\"vim\\",wiki:\\"Wiki markup\\",xojo:\\"Xojo (REALbasic)\\",yaml:\\"YAML\\"};Prism.plugins.toolbar.registerButton(\\"show-language\\",function(e){var t=e.element.parentNode;if(t&&/pre/i.test(t.nodeName))return t=t.getAttribute(\\"data-language\\")||n[e.language]||e.language.substring(0,1).toUpperCase()+e.language.substring(1),(e=document.createElement(\\"span\\")).textContent=t,e})}}(),window.Zepto(function(o){var e=o(\\".frame-row.native-frame\\").length,t=o(\\".frame-row\\").length;function n(){o(\\".frame-preview\\").removeClass(\\"is-hidden\\"),o(\\"#frames-filter\\").prop(\\"checked\\")?o(\\".frame-row.native-frame\\").addClass(\\"force-show\\"):o(\\".frame-row.native-frame\\").removeClass(\\"force-show\\")}function r(e){var e=o(e).find(\\".frame-context\\"),t=0===(t=e.html()).trim().length?\\"Missing stack frames\\":t,n=e.attr(\\"data-line\\"),r=e.attr(\\"data-start\\"),i=e.attr(\\"data-file\\"),a=e.attr(\\"data-method\\"),e=e.attr(\\"data-line-column\\");o(\\"#code-drop\\").parent(\\"pre\\").attr(\\"data-line\\",n),o(\\"#code-drop\\").parent(\\"pre\\").attr(\\"data-start\\",r),o(\\"#code-drop\\").parent(\\"pre\\").attr(\\"data-line-offset\\",Number(r)-1),o(\\"#code-drop\\").html(t),o(\\"#frame-file\\").html(i),o(\\"#frame-method\\").html(a+\\" \\"+e),window.Prism.highlightAll()}o(\\".frame-row\\").click(function(){o(\\".frame-row\\").removeClass(\\"active\\"),o(this).addClass(\\"active\\"),r(this)}),o(\\"#frames-filter\\").click(function(){n()}),e!==t&&o(\\".frame-preview\\").removeClass(\\"is-hidden\\"),r(o(\\".frame-row.active\\")[0]),n()});
				  </script>
				</body>
				</html>
				"
			`);

			// test further changes that fix the code
			fireAndForgetFakeUserWorkerChanges({
				script: `
					export default {
						fetch() {
							return new Response("body:3");
						}
					}
				`,
				mfOpts: run.mfOpts,
				config: run.config,
			});

			res = await run.worker.fetch("http://dummy");
			await expect(res.text()).resolves.toBe("body:3");

			consoleErrorSpy.mockReset();
			res = await run.worker.fetch("http://dummy");
			await expect(res.text()).resolves.toBe("body:3");
			expect(consoleErrorSpy).not.toHaveBeenCalled();
		},
		{ retry: 10 } // for some reason vi.spyOn(console, 'error') is flakey
	);

	test("config.dev.{server,inspector} changes, restart the server instance", async () => {
		const run = await fakeStartUserWorker({
			script: `
				export default {
					fetch() {
						return new Response("body:1");
					}
				}
			`,
			config: {
				dev: {
					server: { port: await getPort() },
					inspector: { port: await getPort() },
				},
			},
		});

		res = await run.worker.fetch("http://dummy");
		await expect(res.text()).resolves.toBe("body:1");

		const oldPort = run.config.dev?.server?.port;
		res = await undici.fetch(`http://127.0.0.1:${oldPort}`);
		await expect(res.text()).resolves.toBe("body:1");

		const config2 = fakeConfigUpdate({
			...run.config,
			dev: {
				server: { port: await getPort() },
				inspector: { port: await getPort() },
			},
		});
		fakeReloadStart(config2);
		fakeReloadComplete(config2, run.mfOpts, run.url);

		const newPort = config2.dev?.server?.port;

		res = await run.worker.fetch("http://dummy");
		await expect(res.text()).resolves.toBe("body:1");

		res = await undici.fetch(`http://127.0.0.1:${newPort}`);
		await expect(res.text()).resolves.toBe("body:1");

		await expect(
			undici.fetch(`http://127.0.0.1:${oldPort}`).then((r) => r.text())
		).rejects.toMatchInlineSnapshot("[TypeError: fetch failed]");
	});

	test("liveReload", async () => {
		let resText: string;
		const scriptRegex = /<script>([\s\S]*)<\/script>/gm;

		const run = await fakeStartUserWorker({
			script: `
				export default {
					fetch() {
						return new Response("body:1", {
							headers: { 'Content-Type': 'text/html' }
						});
					}
				}
			`,
			config: {
				dev: { liveReload: true },
			},
		});

		// test liveReload: true inserts live-reload <script> tag when the response Content-Type is html
		res = await run.worker.fetch("http://dummy");
		resText = await res.text();
		expect(resText).toEqual(expect.stringContaining("body:1"));
		expect(resText).toEqual(expect.stringMatching(scriptRegex));
		expect(resText.replace(scriptRegex, "").trim()).toEqual("body:1"); // test, without the <script> tag, the response is as authored

		fireAndForgetFakeUserWorkerChanges({
			mfOpts: run.mfOpts,
			script: `
				export default {
					fetch() {
						return new Response("body:2");
					}
				}
			`,
			config: {
				...run.config,
				dev: { liveReload: true },
			},
		});

		// test liveReload does nothing when the response Content-Type is not html
		res = await run.worker.fetch("http://dummy");
		resText = await res.text();
		expect(resText).toMatchInlineSnapshot('"body:2"');
		expect(resText).toBe("body:2");
		expect(resText).not.toEqual(expect.stringMatching(scriptRegex));

		fireAndForgetFakeUserWorkerChanges({
			mfOpts: run.mfOpts,
			script: `
				export default {
					fetch() {
						return new Response("body:3", {
							headers: { 'Content-Type': 'text/html' }
						});
					}
				}
			`,
			config: {
				...run.config,
				dev: { liveReload: false },
			},
		});

		// test liveReload: false does nothing even when the response Content-Type is html
		res = await run.worker.fetch("http://dummy");
		resText = await res.text();
		expect(resText).toMatchInlineSnapshot('"body:3"');
		expect(resText).toBe("body:3");
		expect(resText).not.toEqual(expect.stringMatching(scriptRegex));
	});

	test("urlOverrides take effect in the UserWorker", async () => {
		const run = await fakeStartUserWorker({
			script: `
				export default {
					fetch(request) {
						return new Response("URL: " + request.url);
					}
				}
			`,
			config: {
				dev: {
					urlOverrides: {
						hostname: "www.google.com",
					},
				},
			},
		});

		console.log("ProxyWorker", await devEnv.proxy.proxyWorker?.ready);
		console.log("UserWorker", run.url);
		res = await run.worker.fetch("http://dummy/test/path/1");
		await expect(res.text()).resolves.toBe(
			`URL: http://www.google.com/test/path/1`
		);

		const config2 = fakeConfigUpdate({
			...run.config,
			dev: {
				...run.config.dev,
				urlOverrides: {
					secure: true,
					hostname: "mybank.co.uk",
				},
			},
		});
		fakeReloadComplete(config2, run.mfOpts, run.url, 1000);

		res = await run.worker.fetch("http://dummy/test/path/2");
		await expect(res.text()).resolves.toBe(
			"URL: https://mybank.co.uk/test/path/2"
		);
	});
});
