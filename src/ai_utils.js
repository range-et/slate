import OpenAI from "openai";
import { OPENAI_API_KEY } from "./config";

class OpenAIAgent {
    constructor() {
        this.client = new OpenAI({
            apiKey: OPENAI_API_KEY,
            dangerouslyAllowBrowser: true
        });
    }

    async generateSummary(content) {
        let concatenatedContent = content.join("\n");
        const response = await this.client.responses.create({
            model: "gpt-5",
            input: "Generate a summary of the following content: " + concatenatedContent
        });
        return response.output_text;
    }

    async generateResponse(prompt) {
        const response = await this.client.responses.create({
            model: "gpt-5",
            input: "Generate a informative response for the following prompt: " + prompt
        });
        return response.output_text;
    }
}

export default OpenAIAgent;