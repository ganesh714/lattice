export class PromptSanitizer {
    private static patterns: { name: string; regex: RegExp }[] = [
        { name: 'destructive_keyword', regex: /\b(delete|wipe|erase|destroy)\b/i },
        { name: 'delete_request', regex: /\b(delete|remove|wipe|erase)\b.*\b(all|everything|entire|whole)\b/i },
        { name: 'rewrite_all', regex: /\brewrite\b.*\b(all|everything|entire|whole)\b/i },
        { name: 'mass_refactor', regex: /\b(refactor|replace|modify)\b.*\b(all|everything|entire|whole)\b/i },
        { name: 'rm -rf', regex: /rm\s+-rf/i },
        { name: 'sudo', regex: /\bsudo\b/i },
        { name: 'curl_pipe_bash', regex: /curl\s+[^|]+\|\s*bash/i },
        { name: 'wget_pipe_bash', regex: /wget\s+[^|]+\|\s*bash/i },
        { name: 'base64_decode', regex: /base64\s+-d/i },
        { name: 'ssh', regex: /\bssh\b/i },
        { name: 'drop_table', regex: /\bdrop\s+table\b/i },
        { name: 'alter_table', regex: /\balter\s+table\b/i },
        { name: 'process_exit', regex: /\b(process|System)\.(exit|kill)\b/i },
        { name: 'eval_exec', regex: /\b(eval|exec)\s*\(/i },
        { name: 'private_key', regex: /-----BEGIN( RSA)? PRIVATE KEY-----/i },
        { name: 'aws_key_keyword', regex: /\b(AWS|aws)_?(ACCESS|SECRET)?_?KEY\b/i }
    ];

    static check(prompt: string): { blocked: boolean; matches: string[] } {
        if (!prompt || typeof prompt !== 'string') return { blocked: false, matches: [] };
        const matches: string[] = [];
        for (const p of this.patterns) {
            if (p.regex.test(prompt)) matches.push(p.name);
        }
        return { blocked: matches.length > 0, matches };
    }
}

export default PromptSanitizer;
