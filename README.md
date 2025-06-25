# LangSmith Tracer Plugin

A comprehensive tracing plugin for the [LLM Gateway](https://github.com/nullplatform/llmgateway) that sends conversation data to [LangSmith](https://smith.langchain.com) for observability, debugging, and performance monitoring.

Using it you can track LLM requests and responses even if you can't modify the caller code, for example, you could capture all N8N llm conversations

## Features

🔍 **Complete Conversation Tracing** - Captures LLM requests, responses, and tool interactions  
⚡ **Batched Sending** - Efficient batch processing to reduce API calls  
🛠️ **Tool Call Support** - Tracks tool usage with proper parent-child relationships  
🔗 **Cross-Request Correlation** - Groups related tool interactions across multiple HTTP requests  
📊 **Rich Metadata** - Includes tokens, timing, models, experiments, and custom data  
🎯 **Project Organization** - Organizes traces under configurable projects and sessions

## LLM Gateway Configuration
### Install

```bash
npm i -g @llmgatewayai/langsmith-tracer 
```

### Basic Configuration

```yaml

availablePlugins:
  - module: "@llmgatewayai/langsmith-tracer"
    
plugins:
  - name: langsmith-tracer-default
    type: langsmith-tracer
    config:
      apiKey: "${LANGSMITH_API_KEY}"
      projectName: "my-llm-gateway"
```

### Full Configuration

```yaml
availablePlugins:
  - module: "@llmgatewayai/langsmith-tracer"
    
plugins:
  - name: langsmith-tracer
    type: langsmith-tracer
    config:
      # Required: Your LangSmith API key
      apiKey: "${LANGSMITH_API_KEY}"
      
      # Optional: LangSmith API URL (defaults to official API)
      apiUrl: "https://api.smith.langchain.com"
      
      # Optional: Project name for organizing traces
      projectName: "production-gateway"
      
      # Optional: Session name for grouping related conversations
      sessionName: "web-app-sessions"
      
      # Optional: Number of runs to batch before sending (1-100)
      batchSize: 10
      
      # Optional: Flush interval in milliseconds (1000-60000)
      flushInterval: 5000
      
      # Optional: Enable debug logging
      debug: false
```

## Trace Structure

The plugin creates the following trace hierarchy in LangSmith:

```
Project: "production-gateway"
├── Session: "user-session-123"
│   ├── LLM Run: "gpt-4 completion" (parent)
│   │   ├── inputs: messages, model, temperature, etc.
│   │   └── outputs: response content, usage, etc.
│   ├── Tool Run: "weather_function" (child)
│   │   ├── inputs: function_name, arguments
│   │   └── outputs: tool results
│   └── LLM Run: "Tool response - gpt-4" (child)
│       └── outputs: final response with tool data
```

## Multi-Turn Tool Conversations

The plugin handles tool conversations that span multiple HTTP requests:

### Example Flow:

**Request 1:** User asks "What's the weather in NYC?"
- Creates parent LLM run
- Stores run ID for future correlation
- Tool call: `get_weather(location="NYC")`

**Request 2:** Tool response comes back
- Links to original parent run using cached run ID
- Creates proper parent-child relationship
- Maintains conversation context

## Metadata Captured

### LLM Runs
- **Request Data**: Messages, model, temperature, max_tokens, etc.
- **Response Data**: Content, usage statistics, finish_reason
- **Timing**: Start time, end time, duration
- **Context**: User ID, session ID, request ID
- **Experiments**: Experiment ID, variant
- **Tool Info**: Tool definitions, tool usage flags

### Tool Runs
- **Function Details**: Name, arguments, execution order
- **Correlation**: Tool call ID, parent run ID
- **Context**: Request ID, user context

### Debug Mode
Enable debug logging to see detailed plugin activity:

```yaml
config:
  debug: true
```
## License

MIT License - see LICENSE file for details.

## Support

- **Issues**: Create GitHub issues for bugs or feature requests
