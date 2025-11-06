import OpenAI from "openai";
import { OPENAI_API_KEY } from "./config";

class OpenAIAgent {
    constructor() {
        // Try to load API key from localStorage first, then fall back to config
        const apiKey = localStorage.getItem('openai_api_key') || OPENAI_API_KEY;
        
        this.client = new OpenAI({
            apiKey: apiKey,
            dangerouslyAllowBrowser: true
        });
    }

    async generateSummary(content) {
        const response = await this.client.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: "You are a helpful assistant that creates concise summaries of documents. Provide a clear, informative summary that captures the key points. Format your response using Markdown with numbered lists, bold text for emphasis, and proper structure."
                },
                {
                    role: "user",
                    content: `Generate a summary of the following content:\n\n${content}`
                }
            ],
            temperature: 0.7,
            max_tokens: 500
        });
        return response.choices[0].message.content;
    }

    async generateResponse(prompt) {
        const response = await this.client.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: "You are a helpful assistant that provides concise, informative responses. Keep your answers brief and to the point while maintaining clarity. Focus on the essential information and avoid unnecessary elaboration. Format your response using Markdown with headings, lists, bold/italic text, code blocks, and other formatting as appropriate for clarity and readability."
                },
                {
                    role: "user",
                    content: prompt
                }
            ],
            temperature: 0.7,
            max_tokens: 500
        });
        return response.choices[0].message.content;
    }
}

export default OpenAIAgent;