import * as vscode from 'vscode';

type ApiType = 'openai-compatible' | 'anthropic' | 'gemini';

interface ProviderConfig {
	id: string;
	name: string;
	apiType: ApiType;
	baseUrl: string;
	model: string;
}

interface ApiMessage {
	role: 'user' | 'assistant' | 'system';
	content: string;
}

type JsonRecord = Record<string, unknown>;

const PROVIDERS_KEY = 'providers';
const SECRET_PREFIX = 'apiKey:';
const VENDOR_ID = 'local-dev-any-ai-provider';

const defaultUrls: Record<ApiType, string> = {
	'openai-compatible': 'https://api.openai.com/v1',
	anthropic: 'https://api.anthropic.com/v1',
	gemini: 'https://generativelanguage.googleapis.com/v1beta',
};

class AnyAiProvider implements vscode.LanguageModelChatProvider {
	private readonly modelListChanged = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this.modelListChanged.event;

	constructor(private readonly context: vscode.ExtensionContext) {}

	refresh(): void {
		this.modelListChanged.fire();
	}

	dispose(): void {
		this.modelListChanged.dispose();
	}

	async provideLanguageModelChatInformation(
		options: { silent: boolean },
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelChatInformation[]> {
		if (token.isCancellationRequested) {
			return [];
		}

		const providers = this.getProviders();
		if (providers.length === 0 && !options.silent) {
			void vscode.window.showInformationMessage(
				'Add a model with Any AI Provider: Manage Providers.',
			);
		}

		return providers.map((provider) => ({
			id: provider.id,
			name: `${provider.name} - ${provider.model}`,
			family: provider.model,
			version: '1',
			maxInputTokens: 128_000,
			maxOutputTokens: 8_192,
			tooltip: provider.baseUrl,
			detail: provider.apiType,
			capabilities: { imageInput: false, toolCalling: false },
		}));
	}

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		_options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const provider = this.getProviders().find((item) => item.id === model.id);
		if (!provider) {
			throw new Error('This model is no longer configured. Refresh the model picker and try again.');
		}

		const apiKey = await this.context.secrets.get(`${SECRET_PREFIX}${provider.id}`);
		const apiMessages = messages
			.map((message) => ({
				role: messageRole(message.role),
				content: message.content
					.filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart)
					.map((part) => part.value)
					.join(''),
			}))
			.filter((message) => message.content.length > 0);

		const abortController = new AbortController();
		const cancellation = token.onCancellationRequested(() => abortController.abort());
		try {
			if (provider.apiType === 'anthropic') {
				await this.streamAnthropic(provider, apiKey, apiMessages, progress, abortController.signal);
			} else if (provider.apiType === 'gemini') {
				await this.streamGemini(provider, apiKey, apiMessages, progress, abortController.signal);
			} else {
				await this.streamOpenAiCompatible(provider, apiKey, apiMessages, progress, abortController.signal);
			}
		} finally {
			cancellation.dispose();
		}
	}

	async provideTokenCount(
		_model: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
		token: vscode.CancellationToken,
	): Promise<number> {
		if (token.isCancellationRequested) {
			return 0;
		}
		const value = typeof text === 'string'
			? text
			: text.content
				.filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart)
				.map((part) => part.value)
				.join('');
		return Math.ceil(value.length / 4);
	}

	private getProviders(): ProviderConfig[] {
		return this.context.globalState.get<ProviderConfig[]>(PROVIDERS_KEY, []);
	}

	private async streamOpenAiCompatible(
		provider: ProviderConfig,
		apiKey: string | undefined,
		messages: ApiMessage[],
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		signal: AbortSignal,
	): Promise<void> {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (apiKey) {
			headers.Authorization = `Bearer ${apiKey}`;
		}
		const response = await fetch(endpoint(provider.baseUrl, 'chat/completions'), {
			method: 'POST',
			headers,
			body: JSON.stringify({
				model: provider.model,
				messages,
				stream: true,
			}),
			signal,
		});
		await consumeSse(response, (data) => {
			if (data === '[DONE]') {
				return;
			}
			const chunk = parseJson(data);
			const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
			const firstChoice = asRecord(choices[0]);
			const delta = asRecord(firstChoice?.delta);
			const content = delta?.content;
			if (typeof content === 'string' && content.length > 0) {
				progress.report(new vscode.LanguageModelTextPart(content));
			}
		});
	}

	private async streamAnthropic(
		provider: ProviderConfig,
		apiKey: string | undefined,
		messages: ApiMessage[],
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		signal: AbortSignal,
	): Promise<void> {
		if (!apiKey) {
			throw new Error(`An API key is required for ${provider.name}. Add one using Manage Providers.`);
		}
		const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
		const response = await fetch(endpoint(provider.baseUrl, 'messages'), {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': apiKey,
				'anthropic-version': '2023-06-01',
			},
			body: JSON.stringify({
				model: provider.model,
				max_tokens: 8_192,
				stream: true,
				...(system ? { system } : {}),
				messages: messages
					.filter((message) => message.role !== 'system')
					.map(({ role, content }) => ({ role, content })),
			}),
			signal,
		});
		await consumeSse(response, (data) => {
			const event = parseJson(data);
			if (event.type === 'error') {
				const error = asRecord(event.error);
				throw new Error(stringValue(error?.message) ?? 'The Anthropic API returned an error.');
			}
			const delta = asRecord(event.delta);
			const text = delta?.text;
			if (event.type === 'content_block_delta' && typeof text === 'string') {
				progress.report(new vscode.LanguageModelTextPart(text));
			}
		});
	}

	private async streamGemini(
		provider: ProviderConfig,
		apiKey: string | undefined,
		messages: ApiMessage[],
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		signal: AbortSignal,
	): Promise<void> {
		if (!apiKey) {
			throw new Error(`An API key is required for ${provider.name}. Add one using Manage Providers.`);
		}
		const system = messages.filter((message) => message.role === 'system').map((message) => message.content);
		const response = await fetch(
			`${endpoint(provider.baseUrl, `models/${encodeURIComponent(provider.model)}:streamGenerateContent`)}?alt=sse`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
				body: JSON.stringify({
					...(system.length > 0 ? { system_instruction: { parts: system.map((text) => ({ text })) } } : {}),
					contents: messages
						.filter((message) => message.role !== 'system')
						.map((message) => ({
							role: message.role === 'assistant' ? 'model' : 'user',
							parts: [{ text: message.content }],
						})),
					generationConfig: { maxOutputTokens: 8_192 },
				}),
				signal,
			},
		);
		await consumeSse(response, (data) => {
			const chunk = parseJson(data);
			const candidates = Array.isArray(chunk.candidates) ? chunk.candidates : [];
			const firstCandidate = asRecord(candidates[0]);
			const content = asRecord(firstCandidate?.content);
			const parts = Array.isArray(content?.parts) ? content.parts : [];
			for (const item of parts) {
				const part = asRecord(item);
				const text = part?.text;
				if (typeof text === 'string' && text.length > 0) {
					progress.report(new vscode.LanguageModelTextPart(text));
				}
			}
		});
	}
}

function messageRole(role: vscode.LanguageModelChatMessageRole): ApiMessage['role'] {
	switch (role) {
		case vscode.LanguageModelChatMessageRole.User:
			return 'user';
		case vscode.LanguageModelChatMessageRole.Assistant:
			return 'assistant';
		default:
			return 'system';
	}
}

function endpoint(baseUrl: string, path: string): string {
	return `${baseUrl.replace(/\/+$/, '')}/${path}`;
}

function asRecord(value: unknown): JsonRecord | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? value as JsonRecord
		: undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function parseJson(data: string): JsonRecord {
	try {
		const parsed: unknown = JSON.parse(data);
		const record = asRecord(parsed);
		if (!record) {
			throw new Error();
		}
		return record;
	} catch {
		throw new Error('The model provider returned an invalid streaming response.');
	}
}

async function consumeSse(response: Response, onData: (data: string) => void): Promise<void> {
	if (!response.ok) {
		const details = (await response.text()).slice(0, 1_000);
		throw new Error(`Model provider request failed (${response.status}): ${details || response.statusText}`);
	}
	if (!response.body) {
		throw new Error('The model provider returned an empty response stream.');
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let dataLines: string[] = [];

	const dispatch = () => {
		if (dataLines.length > 0) {
			onData(dataLines.join('\n'));
			dataLines = [];
		}
	};

	while (true) {
		const { done, value } = await reader.read();
		buffer += decoder.decode(value, { stream: !done });
		const lines = buffer.split(/\r?\n/);
		buffer = lines.pop() ?? '';
		for (const line of lines) {
			if (line.length === 0) {
				dispatch();
			} else if (line.startsWith('data:')) {
				dataLines.push(line.slice(5).trimStart());
			}
		}
		if (done) {
			if (buffer.startsWith('data:')) {
				dataLines.push(buffer.slice(5).trimStart());
			}
			dispatch();
			return;
		}
	}
}

async function manageProviders(context: vscode.ExtensionContext, chatProvider: AnyAiProvider): Promise<void> {
	const providers = context.globalState.get<ProviderConfig[]>(PROVIDERS_KEY, []);
	const choices: Array<vscode.QuickPickItem & { action: 'add' | 'remove'; provider?: ProviderConfig }> = [
		{ label: '$(add) Add a provider', action: 'add' },
		...providers.map((provider) => ({
			label: `$(trash) Remove ${provider.name} (${provider.model})`,
			action: 'remove' as const,
			provider,
		})),
	];
	const selection = await vscode.window.showQuickPick(choices, { title: 'Manage AI providers' });
	if (!selection) {
		return;
	}

	if (selection.action === 'remove' && selection.provider) {
		const provider = selection.provider;
		const confirmed = await vscode.window.showWarningMessage(
			`Remove ${provider.name} (${provider.model})?`,
			{ modal: true },
			'Remove',
		);
		if (confirmed === 'Remove') {
			await context.globalState.update(
				PROVIDERS_KEY,
				providers.filter((item) => item.id !== provider.id),
			);
			await context.secrets.delete(`${SECRET_PREFIX}${provider.id}`);
			chatProvider.refresh();
		}
		return;
	}

	const apiType = await vscode.window.showQuickPick(
		[
			{ label: 'OpenAI-compatible', description: 'OpenAI, OpenRouter, Groq, Ollama, custom endpoints', value: 'openai-compatible' as const },
			{ label: 'Anthropic', description: 'Anthropic Messages API', value: 'anthropic' as const },
			{ label: 'Google Gemini', description: 'Gemini generateContent API', value: 'gemini' as const },
		],
		{ title: 'Choose API type' },
	);
	if (!apiType) {
		return;
	}

	const name = await vscode.window.showInputBox({ title: 'Provider name', prompt: 'A name shown in the VS Code model picker' });
	if (!name?.trim()) {
		return;
	}
	const model = await vscode.window.showInputBox({ title: 'Model ID', prompt: 'The exact model ID from your provider' });
	if (!model?.trim()) {
		return;
	}
	const baseUrl = await vscode.window.showInputBox({
		title: 'API base URL',
		prompt: 'Base URL without query parameters; the API path is added automatically',
		value: defaultUrls[apiType.value],
		validateInput: validateBaseUrl,
	});
	if (!baseUrl?.trim()) {
		return;
	}
	const apiKey = await vscode.window.showInputBox({
		title: 'API key',
		prompt: apiType.value === 'openai-compatible'
			? 'Leave blank only for a local endpoint that does not require a key'
			: 'Your API key is stored securely in VS Code SecretStorage',
		password: true,
	});
	if (apiKey === undefined) {
		return;
	}
	if (apiType.value !== 'openai-compatible' && !apiKey.trim()) {
		void vscode.window.showErrorMessage('An API key is required for this API type.');
		return;
	}

	const provider: ProviderConfig = {
		id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		name: name.trim(),
		apiType: apiType.value,
		baseUrl: baseUrl.replace(/\/+$/, ''),
		model: model.trim(),
	};
	if (apiKey.trim()) {
		await context.secrets.store(`${SECRET_PREFIX}${provider.id}`, apiKey.trim());
	}
	await context.globalState.update(PROVIDERS_KEY, [...providers, provider]);
	chatProvider.refresh();
	void vscode.window.showInformationMessage(`Added ${provider.name} (${provider.model}).`);
}

function validateBaseUrl(value: string): string | undefined {
	try {
		const url = new URL(value);
		if (!['http:', 'https:'].includes(url.protocol) || url.search || url.hash || url.username || url.password) {
			return 'Enter an HTTP(S) base URL without credentials, query parameters, or a fragment.';
		}
		if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
			return 'Use HTTPS for remote providers; plain HTTP is allowed only for localhost.';
		}
		return undefined;
	} catch {
		return 'Enter a valid HTTP(S) base URL.';
	}
}

export function activate(context: vscode.ExtensionContext): void {
	const chatProvider = new AnyAiProvider(context);
	context.subscriptions.push(
		chatProvider,
		vscode.lm.registerLanguageModelChatProvider(VENDOR_ID, chatProvider),
		vscode.commands.registerCommand('any-ai-provider.manage', () => manageProviders(context, chatProvider)),
	);
}
