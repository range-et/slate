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
        const response = await this.client.responses.create({
            model: "gpt-5",
            input: "Generate a summary of the following content: " + content
        });
        return response.output_text;
    }
}

export default OpenAIAgent;