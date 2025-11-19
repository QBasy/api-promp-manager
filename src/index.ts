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

        $('script, style, nav, header, footer, .breadcrumb, .drawer-toggles, .notifications, button, noscript, iframe, svg').remove();

        const cleanText = $('body').text()
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, 4000);

        const gptRes = await axios.post(
            "https://api.openai.com/v1/chat/completions",
            {
                model: "gpt-4o-mini",
                messages: [{
                    role: "system",
                    content: "Ты извлекаешь вопросы из текста. Отвечай ТОЛЬКО валидным JSON без лишнего текста."
                }, {
                    role: "user",
                    content: `Найди все вопросы. Верни JSON массив:
[{"id":1,"text":"вопрос","options":["A","B"]}]

Правила:
- Только вопросы, игнорируй навигацию
- Если нет вариантов - не добавляй options
- Максимум 50 вопросов
- Текст вопроса - максимум 200 символов

Текст: ${cleanText}`
                }],
                max_tokens: 3000,
                temperature: 0.1
            },
            { headers: { Authorization: `Bearer ${process.env.OPENAI_KEY}` } }
        );

        let rawQuestions = gptRes.data.choices[0].message.content.trim();
        rawQuestions = rawQuestions.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();

        let questions: Question[] = [];
        try {
            const parsed = JSON.parse(rawQuestions);
            const arr = Array.isArray(parsed) ? parsed : (parsed.questions || []);
            questions = arr
                .filter((q: any) => q && q.text && typeof q.text === 'string' && q.text.trim().length > 0)
                .slice(0, 50)
                .map((q: any, idx: number) => ({
                    id: idx + 1,
                    text: q.text.trim().substring(0, 500),
                    options: Array.isArray(q.options) ? q.options.slice(0, 10) : undefined
                }));
        } catch (err) {
            console.error("Parse error:", err);
            return reply.code(400).send({ error: "Failed to parse questions from GPT", raw: rawQuestions.substring(0, 500) });
        }

        if (questions.length === 0) {
            return reply.send({ ok: true, count: 0, message: "No questions found" });
        }

        const batches = [];
        for (let i = 0; i < questions.length; i += 10) {
            batches.push(questions.slice(i, i + 10));
        }

        const allAnswers: Answer[] = [];

        for (const batch of batches) {
            let prompt = "Ответь кратко (формат: 1. ответ):\n\n";
            batch.forEach(q => {
                prompt += `${q.id}. ${q.text}\n`;
                if (q.options) prompt += `Варианты: ${q.options.join(", ")}\n`;
            });

            const gptAnswerRes = await axios.post(
                "https://api.openai.com/v1/chat/completions",
                {
                    model: "gpt-4o-mini",
                    messages: [{ role: "user", content: prompt }],
                    max_tokens: 1000
                },
                { headers: { Authorization: `Bearer ${process.env.OPENAI_KEY}` } }
            );

            const rawAnswers = gptAnswerRes.data.choices[0].message.content.trim();

            let currentId: number | null = null, buffer = "";
            rawAnswers.split("\n").forEach((line: string) => {
                const match = line.match(/^(\d+)[).:\s]+(.+)/);
                if (match) {
                    if (currentId !== null && buffer.trim() !== "") {
                        allAnswers.push({
                            id: currentId,
                            question: questions.find(q => q.id === currentId)?.text || "",
                            answer: buffer.trim()
                        });
                    }
                    currentId = parseInt(match[1]);
                    buffer = match[2];
                } else if (currentId) {
                    buffer += " " + line.trim();
                }
            });

            if (currentId !== null && buffer.trim() !== "") {
                allAnswers.push({
                    id: currentId,
                    question: questions.find(q => q.id === currentId)?.text || "",
                    answer: buffer.trim()
                });
            }
        }

        let existing: Answer[] = [];
        try {
            const fileContent = await fs.readFile(answersPath, "utf-8");
            existing = JSON.parse(fileContent) as Answer[];
        } catch {}

        await fs.writeFile(answersPath, JSON.stringify([...existing, ...allAnswers], null, 2));

        return reply.send({ ok: true, count: allAnswers.length, questions: questions.length });

    } catch (err: any) {
        console.error(err);
        return reply.code(500).send({ error: err.message });
    }
});

fastify.register(fastifyStatic, { root: path.join(process.cwd(), "static"), prefix: "/" });

fastify.get("/json", async (req, reply) => {
    try {
        const fileContent = await fs.readFile(answersPath, "utf-8");
        const answers = JSON.parse(fileContent) as Answer[];
        reply.header("Content-Type", "application/json").send(answers);
    } catch {
        reply.code(404).send({ error: "answers.json not found" });
    }
});

fastify.post("/clear-answers", async (req, reply) => {
    try {
        await fs.writeFile(answersPath, "[]", "utf-8");
        return reply.send({ ok: true, message: "answers.json очищен" });
    } catch (err: any) {
        console.error(err);
        return reply.code(500).send({ error: err.message });
    }
});

const PORT = parseInt(process.env.PORT || "3000");
fastify.listen({ port: PORT, host: "0.0.0.0" })
    .then(() => console.log(`Server running on port ${PORT}`))
    .catch(console.error);