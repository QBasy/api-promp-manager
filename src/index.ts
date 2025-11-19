import Fastify from "fastify";
import axios from "axios";
import fs from "fs/promises";
import fastifyStatic from "@fastify/static";
import fastifyCors from '@fastify/cors';
import path from "path";
import 'dotenv/config';
import * as cheerio from 'cheerio';

interface Question {
    id: number;
    text: string;
    options?: string[];
}

interface Answer {
    id: number;
    question: string;
    answer: string;
}

const fastify = Fastify({ logger: true });
fastify.register(fastifyCors, { origin: "*" });

const answersPath = path.join(process.cwd(), "static", "answers.json");

fastify.post("/process-html", async (req, reply) => {
    try {
        const { html } = req.body as { html?: string };
        if (!html) return reply.code(400).send({ error: "html required" });

        const $ = cheerio.load(html);

        $('script, style, nav, header, footer, .breadcrumb, .drawer-toggles, .notifications, button, noscript, iframe, svg, form, input[type="hidden"], link, meta').remove();

        let cleanText = $('body').text()
            .replace(/\s+/g, ' ')
            .trim();

        const textForExtraction = cleanText.substring(0, 4000);

        const gptRes = await axios.post(
            "https://api.openai.com/v1/chat/completions",
            {
                model: "gpt-4o-mini",
                messages: [{
                    role: "system",
                    content: "Ты извлекаешь вопросы из текста. СТРОГО JSON массив, без комментариев."
                }, {
                    role: "user",
                    content: `Найди ВСЕ вопросы. Игнорируй навигацию, кнопки, таймеры.

Формат ответа - ТОЛЬКО массив:
[{"id":1,"text":"текст вопроса","options":["A","B"]}]

Если вариантов нет - НЕ добавляй options.

Текст:
${textForExtraction}`
                }],
                max_tokens: 3000,
                temperature: 0
            },
            { headers: { Authorization: `Bearer ${process.env.OPENAI_KEY}` } }
        );

        let rawQuestions = gptRes.data.choices[0].message.content
            .trim()
            .replace(/^```json\s*/i, '')
            .replace(/^```\s*/i, '')
            .replace(/```\s*$/i, '')
            .trim();

        let questions: Question[] = [];
        try {
            let parsed = JSON.parse(rawQuestions);
            if (!Array.isArray(parsed)) {
                parsed = parsed.questions || [];
            }

            questions = parsed
                .filter((q: any) => q?.text?.trim())
                .slice(0, 50)
                .map((q: any, idx: number) => ({
                    id: idx + 1,
                    text: String(q.text).trim(),
                    options: Array.isArray(q.options) ? q.options.slice(0, 8) : undefined
                }));
        } catch (err) {
            console.error("Parse error:", err);
            return reply.code(400).send({
                error: "Failed to parse questions",
                raw: rawQuestions.substring(0, 500)
            });
        }

        if (questions.length === 0) {
            return reply.send({ ok: true, count: 0, message: "No questions found" });
        }

        const allAnswers: Answer[] = [];
        const batchSize = 3;

        for (let i = 0; i < questions.length; i += batchSize) {
            const batch = questions.slice(i, i + batchSize);

            const promptLines: string[] = [];
            batch.forEach(q => {
                promptLines.push(`ВОПРОС ${q.id}: ${q.text}`);
                if (q.options) {
                    promptLines.push(`ВАРИАНТЫ: ${q.options.join(" | ")}`);
                }
                promptLines.push('---');
            });

            const prompt = `Ответь на каждый вопрос КРАТКО и ПО СУЩЕСТВУ.

Формат ответа СТРОГО:
${batch.map(q => `${q.id}. [твой ответ здесь]`).join('\n')}

НЕ пиши ничего кроме номера и ответа.
НЕ переформулируй вопросы.
НЕ добавляй пояснения.

${promptLines.join('\n')}

ОТВЕТЫ:`;

            const gptAnswerRes = await axios.post(
                "https://api.openai.com/v1/chat/completions",
                {
                    model: "gpt-4o-mini",
                    messages: [
                        {
                            role: "system",
                            content: "Ты отвечаешь кратко и точно на вопросы. Формат: \"1. ответ\". БЕЗ лишнего текста."
                        },
                        {
                            role: "user",
                            content: prompt
                        }
                    ],
                    max_tokens: 600,
                    temperature: 0.2
                },
                { headers: { Authorization: `Bearer ${process.env.OPENAI_KEY}` } }
            );

            const rawAnswers = gptAnswerRes.data.choices[0].message.content.trim();

            const lines = rawAnswers.split('\n');
            let currentId: number | null = null;
            let buffer = "";

            for (const line of lines) {
                const match = line.match(/^(\d+)[\.\)\:\s]+(.+)/);
                if (match) {
                    if (currentId !== null && buffer.trim()) {
                        const question = questions.find(q => q.id === currentId);
                        if (question) {
                            allAnswers.push({
                                id: currentId,
                                question: question.text,
                                answer: buffer.trim()
                            });
                        }
                    }
                    currentId = parseInt(match[1]);
                    buffer = match[2];
                } else if (currentId && line.trim() && !line.includes('ВОПРОС')) {
                    buffer += " " + line.trim();
                }
            }

            if (currentId !== null && buffer.trim()) {
                const question = questions.find(q => q.id === currentId);
                if (question) {
                    allAnswers.push({
                        id: currentId,
                        question: question.text,
                        answer: buffer.trim()
                    });
                }
            }

            await new Promise(resolve => setTimeout(resolve, 500));
        }

        let existing: Answer[] = [];
        try {
            const fileContent = await fs.readFile(answersPath, "utf-8");
            existing = JSON.parse(fileContent);
        } catch {}

        await fs.writeFile(answersPath, JSON.stringify([...existing, ...allAnswers], null, 2));

        return reply.send({
            ok: true,
            count: allAnswers.length,
            totalQuestions: questions.length
        });

    } catch (err: any) {
        console.error("Error:", err.message);
        return reply.code(500).send({ error: err.message });
    }
});

fastify.register(fastifyStatic, { root: path.join(process.cwd(), "static"), prefix: "/" });

fastify.get("/json", async (req, reply) => {
    try {
        const fileContent = await fs.readFile(answersPath, "utf-8");
        const answers = JSON.parse(fileContent);
        reply.header("Content-Type", "application/json").send(answers);
    } catch {
        reply.code(404).send({ error: "answers.json not found" });
    }
});

fastify.post("/clear-answers", async (req, reply) => {
    try {
        await fs.writeFile(answersPath, "[]", "utf-8");
        return reply.send({ ok: true, message: "Cleared" });
    } catch (err: any) {
        return reply.code(500).send({ error: err.message });
    }
});

const PORT = parseInt(process.env.PORT || "3000");
fastify.listen({ port: PORT, host: "0.0.0.0" })
    .then(() => console.log(`Server running on port ${PORT}`))
    .catch(console.error);