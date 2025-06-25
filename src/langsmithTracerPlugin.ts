import {
    IPlugin,
    PluginMetadata,
    IRequestContext,
    ILLMRequest,
    ILLMResponse,
    IMessage
} from '@nullplatform/llm-gateway-sdk';

export class LangSmithTracerPluginConfig {
    apiUrl?: string;
    apiKey: string;
    projectName?: string;
    debug?: boolean;
    batchSize: number; // Number of records to batch send (default: 10)
    flushInterval: number; // Interval to flush pending records in ms (default: 5 seconds)
    sessionName?: string; // Optional session name for grouping
}

interface LangSmithRun {
    id: string;
    name: string;
    run_type: 'llm' | 'chain' | 'tool';
    inputs: Record<string, any>;
    outputs?: Record<string, any>;
    parent_run_id?: string;
    session_name?: string;
    project_name?: string;
    start_time: string;
    end_time?: string;
    error?: string;
    execution_order?: number;
    serialized?: Record<string, any>;
    events?: any[];
    tags?: string[];
    extra?: Record<string, any>;
}

const ConfigSchema = {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "title": "LangSmith Tracer Plugin Configuration",
    "description": "Configuration schema for the LangSmith tracer plugin",
    "required": ["apiKey"],
    "properties": {
        "apiUrl": {
            "type": "string",
            "title": "LangSmith API URL",
            "description": "The LangSmith API endpoint URL",
            "default": "https://api.smith.langchain.com",
            "format": "uri"
        },
        "apiKey": {
            "type": "string",
            "title": "API Key",
            "description": "LangSmith API key for authentication",
            "format": "password"
        },
        "projectName": {
            "type": "string",
            "title": "Project Name",
            "description": "Default project name for traces",
            "default": "default"
        },
        "debug": {
            "type": "boolean",
            "title": "Debug Mode",
            "description": "Enable debug logging",
            "default": false
        },

        "batchSize": {
            "type": "integer",
            "title": "Batch Size",
            "description": "Number of runs to batch before sending to LangSmith",
            "default": 10,
            "minimum": 1,
            "maximum": 100
        },
        "flushInterval": {
            "type": "integer",
            "title": "Flush Interval",
            "description": "Interval in milliseconds to flush pending runs",
            "default": 5000,
            "minimum": 1000,
            "maximum": 60000
        }
    },
    "additionalProperties": false
};

@PluginMetadata({
    name: 'langsmith-tracer',
    version: '1.0.0',
    description: 'Traces LLM conversations to LangSmith for observability and monitoring',
    configurationSchema: ConfigSchema
})
export class LangSmithTracerPlugin implements IPlugin {
    private config!: LangSmithTracerPluginConfig;
    private pendingRuns: LangSmithRun[] = [];
    private flushTimer?: NodeJS.Timeout;
    private runIdCache: Map<string, string> = new Map(); // interaction_id -> parent_run_id mapping

    async configure(config: LangSmithTracerPluginConfig): Promise<void> {
        this.config = {
            apiUrl: config.apiUrl || 'https://api.smith.langchain.com',
            apiKey: config.apiKey,
            projectName: config.projectName || 'default',
            debug: config.debug || false,
            batchSize: config.batchSize || 10,
            flushInterval: config.flushInterval || 5000,
            sessionName: config.sessionName
        };

        // Start flush timer
        this.startFlushTimer();
    }

    async validateConfig(config: LangSmithTracerPluginConfig): Promise<boolean | string> {
        if (!config.apiKey) {
            return 'LangSmith API key is required';
        }

        if (config.batchSize && config.batchSize < 1) {
            return 'batchSize must be at least 1';
        }

        try {
            // Test LangSmith API connection
            const response = await fetch(`${config.apiUrl || 'https://api.smith.langchain.com'}/api/v1/sessions`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${config.apiKey}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            return true;
        } catch (error) {
            return `Failed to connect to LangSmith: ${error instanceof Error ? error.message : 'Unknown error'}`;
        }
    }

    private startFlushTimer(): void {
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
        }

        this.flushTimer = setInterval(async () => {
            await this.flushPendingRuns();
        }, this.config.flushInterval);
    }

    private async flushPendingRuns(): Promise<void> {
        if (this.pendingRuns.length === 0) {
            return;
        }

        const runsToFlush = this.pendingRuns.splice(0, this.config.batchSize);

        try {
            // Send runs to LangSmith
            for (const run of runsToFlush) {
                await this.sendRunToLangSmith(run);
            }

            if (this.config.debug) {
                console.log(`Successfully sent ${runsToFlush.length} runs to LangSmith`);
            }
        } catch (error) {
            console.error('Failed to send runs to LangSmith:', error);
            // Re-add runs to the beginning of the pending queue for retry
            this.pendingRuns.unshift(...runsToFlush);
        }
    }

    private async sendRunToLangSmith(run: LangSmithRun): Promise<void> {
        const url = `${this.config.apiUrl}/api/v1/runs`;

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'x-api-key': `${this.config.apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(run)
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`LangSmith API error: ${response.status} ${response.statusText} - ${errorText}`);
        }
    }

    private requestWasToolCallback(request: ILLMRequest): boolean {
        return request?.messages?.some((message) => {
            return message.tool_calls?.length > 0 || message.tool_call_id;
        });
    }

    private lookForFirstToolId(content: Partial<IMessage>[]): string | undefined {
        for (const item of content) {
            if (item?.tool_calls?.length) {
                return item.tool_calls[0].id;
            }
        }
        return undefined;
    }

    private calculateRequestFingerprint(request: ILLMRequest): string | undefined {
        return this.lookForFirstToolId(request.messages);
    }

    private calculateResponseFingerprint(response?: ILLMResponse): string | undefined {
        if (!response) return undefined;
        return this.lookForFirstToolId(response.content.map((e) => e.message));
    }

    private calculateInteractionId(context: IRequestContext): string {
        // Check if request was a tool callback
        const requestWasToolCallback = this.requestWasToolCallback(context.request);

        // Check if the response is a tool response
        const responseIsToolUsage = context.response?.content?.some(content =>
            content.message?.role === 'tool' || content.message?.tool_calls?.length > 0
        );

        /*
         Because when tools are used, many messages are exchanged we'll try to create an interaction id using the first tool id.
         It's transient the request id but only for an answer that have tools as next step
         */
        let interactionId: string | undefined = context.session_id;

        if (requestWasToolCallback) {
            interactionId = this.calculateRequestFingerprint(context.request);
        }

        if (responseIsToolUsage) {
            interactionId = interactionId || this.calculateResponseFingerprint(context.response);
        }

        if (!interactionId) {
            interactionId = context.session_id || context.request_id || 'unknown_session';
        }

        return interactionId;
    }

    private generateRunId(): string {
        // Generate UUID v4 compatible string for LangSmith
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    private formatMessagesForLangSmith(messages: IMessage[]): Record<string, any> {
        return {
            messages: messages.map(msg => ({
                role: msg.role,
                content: msg.content,
                name: msg.name,
                tool_calls: msg.tool_calls,
                tool_call_id: msg.tool_call_id
            }))
        };
    }

    private formatResponseForLangSmith(response?: ILLMResponse): Record<string, any> {
        if (!response) return {};

        return {
            id: response.id,
            model: response.model,
            content: response.content,
            usage: response.usage,
            system_fingerprint: response.system_fingerprint
        };
    }

    private extractToolCalls(messages: IMessage[]): any[] {
        const toolCalls: any[] = [];

        for (const message of messages) {
            if (message.tool_calls) {
                toolCalls.push(...message.tool_calls.map(tc => ({
                    id: tc.id,
                    type: tc.type,
                    function: tc.function
                })));
            }
        }

        return toolCalls;
    }

    private createToolRuns(context: IRequestContext, parentRunId: string): LangSmithRun[] {
        const toolRuns: LangSmithRun[] = [];
        const allMessages = [...context.request.messages];

        if (context.response?.content) {
            const responseMessages = context.response.content
                .map(c => c.message)
                .filter(m => m) as IMessage[];
            allMessages.push(...responseMessages);
        }

        const toolCalls = this.extractToolCalls(allMessages);

        toolCalls.forEach((toolCall, index) => {
            const toolRun: LangSmithRun = {
                id: this.generateRunId(),
                name: toolCall.function.name,
                run_type: 'tool',
                parent_run_id: parentRunId,
                inputs: {
                    function_name: toolCall.function.name,
                    arguments: toolCall.function.arguments
                },
                session_name: this.config.projectName,
                project_name: this.config.projectName,
                start_time: new Date(context.metrics.start_time).toISOString(),
                end_time: context.metrics.end_time ? new Date(context.metrics.end_time).toISOString() : new Date().toISOString(),
                execution_order: index + 1,
                tags: ['tool_call', toolCall.function.name],
                extra: {
                    tool_call_id: toolCall.id,
                    request_id: context.request_id,
                    user_id: context.user_id
                }
            };

            toolRuns.push(toolRun);
        });

        return toolRuns;
    }

    private getFinishReason(response?: ILLMResponse): string | undefined {
        if (!response?.content) return undefined;
        const lastContent = response.content[response.content.length - 1];
        return lastContent?.finish_reason || undefined;
    }

    private determineTags(context: IRequestContext): string[] {
        const tags: string[] = [
            'llm_gateway',
            context.target_model_provider || 'unknown_provider',
            context.request.model
        ];

        if (context.adapter) {
            tags.push(`adapter:${context.adapter}`);
        }

        if (context.experiment_id) {
            tags.push(`experiment:${context.experiment_id}`);
        }

        if (context.request.stream) {
            tags.push('streaming');
        }

        // Check for tool usage
        const hasToolCalls = context.request.messages.some(m => m.tool_calls?.length > 0) ||
            context.response?.content?.some(c => c.message?.tool_calls?.length > 0);

        if (hasToolCalls) {
            tags.push('tool_usage');
        }

        return tags;
    }

    async detachedAfterResponse(context: IRequestContext): Promise<void> {
        try {
            const runId = this.generateRunId();
            const now = new Date();

            // Calculate interaction ID using the same logic as ClickHouse tracer
            const interactionId = this.calculateInteractionId(context);

            // Check if this is a continuation of an existing interaction
            const existingParentRunId = this.runIdCache.get(interactionId);

            // Check if request was a tool callback or if response has tool usage
            const requestWasToolCallback = this.requestWasToolCallback(context.request);
            const responseIsToolUsage = context.response?.content?.some(content =>
                content.message?.role === 'tool' || content.message?.tool_calls?.length > 0
            );

            // Determine if this run should have a parent
            let parentRunId: string | undefined = undefined;

            if (requestWasToolCallback && existingParentRunId) {
                // This is a tool response, it should be a child of the original LLM call
                parentRunId = existingParentRunId;
            }

            // Create main LLM run
            const mainRun: LangSmithRun = {
                id: runId,
                name: requestWasToolCallback ?
                    `Tool response - ${context.request.model}` :
                    `${context.request.model} completion`,
                run_type: 'llm',
                parent_run_id: parentRunId, // Set parent if this is a tool callback
                inputs: {
                    ...this.formatMessagesForLangSmith(context.request.messages),
                    model: context.request.model,
                    temperature: context.request.temperature,
                    max_tokens: context.request.max_tokens,
                    top_p: context.request.top_p,
                    frequency_penalty: context.request.frequency_penalty,
                    presence_penalty: context.request.presence_penalty,
                    stream: context.request.stream,
                    tools: context.request.tools
                },
                outputs: context.response ? this.formatResponseForLangSmith(context.response) : undefined,
                session_name: this.config.projectName,
                project_name: this.config.projectName, // Use fixed project name, not interaction_id
                start_time: new Date(context.metrics.start_time).toISOString(),
                end_time: context.metrics.end_time ? new Date(context.metrics.end_time).toISOString() : now.toISOString(),
                error: context.error?.message,
                execution_order: 1,
                tags: this.determineTags(context),
                extra: {
                    interaction_id: interactionId,
                    request_id: context.request_id,
                    user_id: context.user_id,
                    session_id: context.session_id,
                    target_model: context.target_model,
                    target_model_provider: context.target_model_provider,
                    adapter: context.adapter,
                    duration_ms: context.metrics.duration_ms,
                    input_tokens: context.metrics.input_tokens,
                    output_tokens: context.metrics.output_tokens,
                    total_tokens: context.metrics.total_tokens,
                    client_ip: context.client_ip,
                    user_agent: context.user_agent,
                    experiment_id: context.experiment_id,
                    experiment_variant: context.experiment_variant,
                    finish_reason: this.getFinishReason(context.response),
                    retry_count: context.retry_count,
                    is_tool_callback: requestWasToolCallback,
                    is_tool_usage: responseIsToolUsage
                }
            };

            // Store the run ID for this interaction if it's the first request in the chain
            // This will be the parent for subsequent tool-related requests
            if (!requestWasToolCallback && !existingParentRunId) {
                this.runIdCache.set(interactionId, runId);
                if (this.config.debug) {
                    console.log(`Stored parent run ID ${runId} for interaction ${interactionId}`);
                }
            }

            // Add main run to pending
            this.pendingRuns.push(mainRun);

            // Create tool runs for immediate tool calls in the response
            if (responseIsToolUsage && !requestWasToolCallback) {
                const toolRuns = this.createToolRuns(context, runId);
                this.pendingRuns.push(...toolRuns);
            }

            // Flush if we've reached the batch size
            if (this.pendingRuns.length >= this.config.batchSize) {
                await this.flushPendingRuns();
            }

        } catch (error) {
            console.error('Error creating LangSmith trace:', error);
            // Don't throw the error to avoid breaking the main request flow
        }
    }

    // Cleanup method to ensure all pending runs are flushed
    async destroy(): Promise<void> {
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
        }

        // Flush any remaining runs
        await this.flushPendingRuns();

        // Clear the run ID cache
        this.runIdCache.clear();
    }
}