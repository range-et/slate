import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import { OPENAI_API_KEY, GEMINI_API_KEY } from "./config_loader.js";

// Shared prompt templates (used by both OpenAI and Gemini)
const SUMMARY_SYSTEM_PROMPT = "You are a helpful assistant that creates concise summaries of documents. Provide a clear, informative summary that captures the key points. Format your response using Markdown with numbered lists, bold text for emphasis, and proper structure.";
const CHAT_SYSTEM_PROMPT = "You are a helpful assistant that provides concise, informative responses. Keep your answers brief and to the point while maintaining clarity. Focus on the essential information and avoid unnecessary elaboration. Format your response using Markdown with headings, lists, bold/italic text, code blocks, and other formatting as appropriate for clarity and readability.";

class OpenAIAgent {
    constructor() {
        // Try to load API key from localStorage first, then fall back to config (if available)
        // Config is optional - only exists locally, not in production
        const apiKey = localStorage.getItem('openai_api_key') || OPENAI_API_KEY || "";
        
        this.apiKey = apiKey; // Store for validation
        
        this.client = new OpenAI({
            apiKey: apiKey,
            dangerouslyAllowBrowser: true
        });
    }
    
    /**
     * Check if API key is set
     * @returns {boolean} True if API key exists
     */
    hasApiKey() {
        return this.apiKey && this.apiKey.trim() !== "";
    }

    async generateSummary(content) {
        if (!this.hasApiKey()) {
            throw new Error("API_KEY_MISSING");
        }
        
        const response = await this.client.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: SUMMARY_SYSTEM_PROMPT },
                { role: "user", content: `Generate a summary of the following content:\n\n${content}` }
            ],
            temperature: 0.7,
            max_tokens: 500
        });
        return response.choices[0].message.content;
    }

    async generateResponse(prompt, images = [], { systemPrompt } = {}) {
        if (!this.hasApiKey()) {
            throw new Error("API_KEY_MISSING");
        }
        let userContent;
        if (images.length > 0) {
            userContent = [{ type: "text", text: prompt }];
            images.forEach(img => {
                userContent.push({
                    type: "image_url",
                    image_url: { url: img.data }
                });
            });
        } else {
            userContent = prompt;
        }
        const response = await this.client.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: systemPrompt || CHAT_SYSTEM_PROMPT },
                { role: "user", content: userContent }
            ],
            temperature: 0.7,
            max_tokens: 4096
        });
        return response.choices[0].message.content;
    }
    
    /**
     * Update the API key and recreate the client
     * @param {string} apiKey - The new API key
     */
    updateApiKey(apiKey) {
        this.apiKey = apiKey;
        this.client = new OpenAI({
            apiKey: apiKey,
            dangerouslyAllowBrowser: true
        });
    }
}

class GeminiAgent {
    constructor() {
        const apiKey = localStorage.getItem('gemini_api_key') || GEMINI_API_KEY || "";
        this.apiKey = apiKey;
        this.client = new GoogleGenAI({ apiKey });
    }

    hasApiKey() {
        return this.apiKey && this.apiKey.trim() !== "";
    }

    async generateSummary(content) {
        if (!this.hasApiKey()) {
            throw new Error("API_KEY_MISSING");
        }
        const response = await this.client.models.generateContent({
            model: "gemini-2.5-flash",
            systemInstruction: SUMMARY_SYSTEM_PROMPT,
            config: { temperature: 0.7, maxOutputTokens: 500 },
            contents: `Generate a summary of the following content:\n\n${content}`
        });
        return response.text ?? "";
    }

    async generateResponse(prompt, images = [], { systemPrompt } = {}) {
        if (!this.hasApiKey()) {
            throw new Error("API_KEY_MISSING");
        }
        let contents;
        if (images.length > 0) {
            const parts = [{ text: prompt }];
            for (const img of images) {
                const match = (img.data || "").match(/^data:([^;]+);base64,(.+)$/);
                const mimeType = match ? match[1] : (img.mimeType || "image/png");
                const data = match ? match[2] : (img.data || "").replace(/^data:[^;]+;base64,/, "");
                parts.push({ inlineData: { mimeType, data } });
            }
            contents = parts;
        } else {
            contents = prompt;
        }
        const response = await this.client.models.generateContent({
            model: "gemini-2.5-flash",
            systemInstruction: systemPrompt || CHAT_SYSTEM_PROMPT,
            config: { temperature: 0.7, maxOutputTokens: 4096 },
            contents
        });
        return response.text ?? "";
    }

    updateApiKey(apiKey) {
        this.apiKey = apiKey;
        this.client = new GoogleGenAI({ apiKey });
    }
}

const DEFAULT_LOCAL_BASE_URL = "http://localhost:11434/v1";
const DEFAULT_LOCAL_MODEL = "qwen2.5-coder:30b";

class LocalAgent {
    constructor(baseURL, modelName) {
        const resolvedBaseURL = baseURL
            || localStorage.getItem('local_base_url')
            || DEFAULT_LOCAL_BASE_URL;
        const resolvedModel = modelName
            || localStorage.getItem('local_model_name')
            || DEFAULT_LOCAL_MODEL;

        this.baseURL = resolvedBaseURL;
        this.modelName = resolvedModel;
        this.apiKey = "local";

        this.client = new OpenAI({
            apiKey: this.apiKey,
            baseURL: this.baseURL,
            dangerouslyAllowBrowser: true
        });
    }

    hasApiKey() {
        return Boolean(this.baseURL && this.modelName);
    }

    async generateSummary(content) {
        const response = await this.client.chat.completions.create({
            model: this.modelName,
            messages: [
                { role: "system", content: SUMMARY_SYSTEM_PROMPT },
                { role: "user", content: `Generate a summary of the following content:\n\n${content}` }
            ],
            temperature: 0.7,
            max_tokens: 500
        });
        return response.choices[0].message.content;
    }

    async generateResponse(prompt, images = [], { systemPrompt } = {}) {
        let userContent;
        if (images.length > 0) {
            userContent = [{ type: "text", text: prompt }];
            images.forEach(img => {
                userContent.push({
                    type: "image_url",
                    image_url: { url: img.data }
                });
            });
        } else {
            userContent = prompt;
        }
        const response = await this.client.chat.completions.create({
            model: this.modelName,
            messages: [
                { role: "system", content: systemPrompt || CHAT_SYSTEM_PROMPT },
                { role: "user", content: userContent }
            ],
            temperature: 0.7,
            max_tokens: 4096
        });
        return response.choices[0].message.content;
    }

    updateApiKey(_apiKey) {
        // Local agent has no API key; this method exists to satisfy the agent shape.
    }

    updateConfig({ baseURL, modelName } = {}) {
        if (baseURL) this.baseURL = baseURL;
        if (modelName) this.modelName = modelName;
        this.client = new OpenAI({
            apiKey: this.apiKey,
            baseURL: this.baseURL,
            dangerouslyAllowBrowser: true
        });
    }
}

export default OpenAIAgent;
export { GeminiAgent, LocalAgent, DEFAULT_LOCAL_BASE_URL, DEFAULT_LOCAL_MODEL };