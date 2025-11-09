import OpenAI from "openai";
import { OPENAI_API_KEY } from "./config_loader.js";

class OpenAIAgent {
    constructor() {
        // Try to load API key from localStorage first, then fall back to config (if available)
        // Config is optional - only exists locally, not in production
        const apiKey = localStorage.getItem('openai_api_key') || OPENAI_API_KEY || "";
        
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

    async generateResponse(prompt, images = []) {
        // Build the user message content
        let userContent;
        
        if (images.length > 0) {
            // Use vision API format with images
            userContent = [
                {
                    type: "text",
                    text: prompt
                }
            ];
            
            // Add each image to the content array
            images.forEach(img => {
                userContent.push({
                    type: "image_url",
                    image_url: {
                        url: img.data  // base64 data URL
                    }
                });
            });
        } else {
            // Text-only format
            userContent = prompt;
        }
        
        const response = await this.client.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: "You are a helpful assistant that provides concise, informative responses. Keep your answers brief and to the point while maintaining clarity. Focus on the essential information and avoid unnecessary elaboration. Format your response using Markdown with headings, lists, bold/italic text, code blocks, and other formatting as appropriate for clarity and readability."
                },
                {
                    role: "user",
                    content: userContent
                }
            ],
            temperature: 0.7,
            max_tokens: 500
        });
        return response.choices[0].message.content;
    }
}

export default OpenAIAgent;