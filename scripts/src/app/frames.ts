/// <reference path="../core/dom.ts" />
/// <reference path="../core/net.ts" />
/// <reference path="../core/types.ts" />
/// <reference path="../core/utils.ts" />
/// <reference path="../app/application.ts" />
/// <reference path="../components/commands.ts" />
/// <reference path="../proxyframe/protocol.ts" />

namespace fugazi.app.frames {
	let remoteProxies = collections.map() as collections.Map<Frame>,
		pendingLoaders = collections.map() as collections.Map<Loader>,
		pendingRequests = collections.map() as collections.Map<Future<ProxyHttpResponse>>,
		framesContainer: HTMLDivElement;

	window.addEventListener("message", envelope => {
		console.log("[app.frames] message received");

		let message;
		try {
			message = proxyframe.baseMessageHandler(envelope);
		} catch (e) {
			return;
		}

		console.log("[app.frames] message data: ", message);

		switch (message.type) {
			case proxyframe.MessageTypes.ProxyFrameHandshake:
				handleRemoteProxyHandshakeMessage(message.data as proxyframe.RemoteProxyHandshakeMessage, envelope.origin);
				break;
			
			case proxyframe.MessageTypes.ProxyFrameExecuteCommandResponse:
				handlerRemoteProxyExecutionResponse(message.data as proxyframe.RemoteProxyExecuteCommandResponse);
				break;
		}
	});

	function handleRemoteProxyHandshakeMessage(message: proxyframe.RemoteProxyHandshakeMessage, origin: string) {
		if (message.frameOrigin != origin) {
			return;
		}

		if (!pendingLoaders.has(message.frameId)) {
			return;
		}

		let loader = pendingLoaders.get(message.frameId);

		loader.onHandshake();
	}

	function handlerRemoteProxyExecutionResponse(message: proxyframe.RemoteProxyExecuteCommandResponse) {
		if (!pendingRequests.has(message.requestId)) {
			return;
		}

		const future = pendingRequests.get(message.requestId);
		const proxyResponse = new ProxyHttpResponse(message);
		if (message.status == "ok") {
			future.resolve(proxyResponse);
		} else {
			future.reject(proxyResponse);
		}
	}

	export interface Frame { }

	export function create<T extends Frame>(source: net.Url): Promise<T> {
		let origin = source.origin,
			future = new Future<Frame>();

		if (!remoteProxies.has(origin)) {
			let frame = new ProxyFrame(source);
			frame.load();
			remoteProxies.set(origin, frame);
		}

		future.resolve(remoteProxies.get(origin));

		return future.asPromise();
	}

	export interface RemoteProxyData {
		id: string;
		scriptsBase: string;
		parentOrigin: string;
	}

	function remoteProxyDataFactory(id: string): RemoteProxyData {
		return {
			id: id,
			scriptsBase: new net.Url("scripts/bin", app.location.base()).toString(),
			parentOrigin: window.location.origin
		};
	}

	class Loader {
		private static LOAD_TIMEOUT = 3000;
		private static HANDSHAKE_TIMEOUT = 3000;

		private id: string;
		private timer: utils.Timer;
		private element: HTMLIFrameElement;
		private future: Future<HTMLIFrameElement>;

		constructor(id: string, source: net.Url) {
			this.future = new Future();
			this.id = id;

			pendingLoaders.set(this.id, this);

			source = source.clone();
			source.setHash(encodeURIComponent(JSON.stringify(remoteProxyDataFactory(this.id))));

			this.element = dom.create("iframe", {}, framesContainer) as HTMLIFrameElement;
			this.element.onload = this.onLoaded.bind(this);
			this.element.src = source.toString();
			this.timer = new utils.Timer(Loader.LOAD_TIMEOUT, this.onFailed.bind(this, "frame load timed out"));
		}

		then(fn: (element: HTMLIFrameElement) => void): Loader {
			this.future.then(fn);
			return this;
		}

		catch(fn: (error: Exception) => void): Loader {
			this.future.catch(fn);
			return this;
		}

		onHandshake(): void {
			this.timer.cancel();
			pendingLoaders.remove(this.id);
			this.future.resolve(this.element);
		}

		private onLoaded(): void {
			this.timer.cancel();
			this.timer = new utils.Timer(Loader.HANDSHAKE_TIMEOUT, this.onFailed.bind(this, "loaded frame is invalid"));
		}

		private onFailed(reason: string): void {
			pendingLoaders.remove(this.id);
			dom.remove(this.element);
			this.future.reject(new Exception(reason));
		}
	}

	class ProxyHttpResponse implements net.HttpResponse {
		private contentType: string;
		private statusCode: number;
		private httpStatus: number;
		private httpStatusText: string;
		private data: string;

		constructor (responseProperties: proxyframe.RemoteProxyExecuteCommandResponse) {
			this.contentType = responseProperties.contentType;
			this.statusCode = responseProperties.statusCode;
			this.httpStatus = responseProperties.httpStatus;
			this.httpStatusText = responseProperties.httpStatusText;
			this.data = responseProperties.data;
		}

		public getXHR(): XMLHttpRequest {
			return null;
		}

		public getStatusCode(): number {
			return this.statusCode;
		}

		public getStatus(): net.Status {
			switch (this.statusCode) {
				case 0:
					return net.Status.None;

				case 200:
					return net.Status.Success;

				case 304:
					return net.Status.NotModified;

				case 408:
					return net.Status.Timeout;

				default:
					return net.Status.Error;
			}
		}

		public getHttpStatus(): number {
			return this.httpStatus;
		}

		public getHttpStatusText(): string {
			return this.httpStatusText;
		}

		public isContentType(contentType: string): boolean {
			return this.getContentType().toLowerCase().startsWith(contentType.toLowerCase());
		}

		public getContentType(): string {
			return this.contentType;
		}

		public getData(): string {
			return this.data;
		}

		public guessData(): any {
			const contentType = net.ContentTypes.fromString(this.contentType);

			if (contentType === net.ContentTypes.Json) {
				return this.getDataAsJson();
			} else {
				return this.getData();
			}
		}

		public getDataAsJson<T>(): any | T {
			try {
				return JSON.parse(this.data);
			} catch (exception) {
				throw new fugazi.Exception("unable to parse response data");
			}
		}

		public getDataAsMap<T>(): collections.Map<T> {
			return collections.map<T>(this.getDataAsJson());
		}
	}

	export class BaseFrame implements Frame {
		private id: string;
		private element: HTMLIFrameElement;
		protected source: net.Url;

		constructor(source: net.Url) {
			this.source = source;
			this.id = utils.generateId({ max: 15, min: 8 });
		}

		public load(): Promise<Frame> {
			let future = new Future<Frame>();

			new Loader(this.id, this.source)
				.then(element => {
						this.element = element;
						this.message(proxyframe.MessageTypes.ProxyFrameHandshakeAck);
						remoteProxies.set(this.source.origin, this);

						future.resolve(this);
					})
				.catch(error => future.reject(error));

			return future.asPromise();
		}

		protected message(type: string, data?: any): string {
			const id = utils.generateId({ min: 5, max: 10 });

			console.log(`[app.frames] posting message of type ${ type } with data: `, data);

			this.element.contentWindow.postMessage(JSON.stringify({
				id: id,
				type: type,
				data: data || {}
			}), this.source.origin);

			return id;
		}
	}

	export class ProxyFrame extends BaseFrame {
		execute(properties: net.RequestProperties, data?: string | net.RequestData): Promise<net.HttpResponse> {
			let future = new Future<ProxyHttpResponse>(),
				message: proxyframe.RemoteProxyExecuteCommandRequest = {
					method: properties.method,
					url: properties.url.toString(),
					headers: properties.headers,
					data: data instanceof collections.Map ? data.asObject() : data
				};

			const messageId = this.message(proxyframe.MessageTypes.ProxyFrameExecuteCommandRequest, message);
			pendingRequests.set(messageId, future);

			return future.asPromise();
		}
	}

	// init
	app.bus.register(app.Events.Loaded, function(): void {
		framesContainer = dom.create("div", {
			id: "frames"
		}, document.body) as HTMLDivElement;
	});
}