import {Codex, ThreadOptions} from "@openai/codex-sdk";

// Pure function 我是用gpt-5.3-codex-spark
// 整合上层我就是使用 mini
const commonThreadOptions: ThreadOptions = {
    model: "gpt-5.3-codex-spark", //  "gpt-5.4-mini"

};

export interface DetailCodingAgentInterface {
    threadId?: string;
}

export class DetailThreadAgent {
    private thread;

    constructor(codex: Codex, detailCodingAgentInterface: DetailCodingAgentInterface) {

        if (detailCodingAgentInterface.threadId) {
            this.thread = codex.resumeThread(detailCodingAgentInterface.threadId, commonThreadOptions);
        } else {
            this.thread = codex.startThread(commonThreadOptions);
        }
    }
}