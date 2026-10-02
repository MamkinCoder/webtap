export declare function extractJson(text: string): unknown;
export declare const outputFormatBlock: (schema: unknown) => string;
/** One prompt from a chat (`### SYSTEM / ### USER / ### OUTPUT FORMAT`), for providers that take a single text. */
export declare function flattenMessages(p: {
    messages: {
        role: string;
        content: string;
    }[];
    systemPrompt?: string;
    responseFormat?: {
        type: "json_schema";
        schema: unknown;
    } | {
        type: "text";
    };
}): string;
/** Fills `structured` from the text when the provider did not, for json_schema requests. */
export declare function withStructured(wantsJson: boolean, r: {
    text: string;
    structured?: unknown;
}): {
    text: string;
    structured?: unknown;
};
