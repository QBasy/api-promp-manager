import Fastify, {FastifyRequest} from "fastify";
import axios from "axios";
import fs from "fs/promises";
import fastifyStatic from "@fastify/static";
import fastifyCors from '@fastify/cors';
import path from "path";
import 'dotenv/config';
import * as cheerio from 'cheerio';
import FormData from "form-data";
import fastifyMultipart, {MultipartFile} from '@fastify/multipart';
import Tesseract from 'tesseract.js';

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

fastify.register(fastifyMultipart);

const answersPath = path.join(process.cwd(), "static", "answers.json");

fastify.post("/process-html", async (req, reply) => {
    try {
        const { html, iframeUrl } = req.body as { html?: string; iframeUrl?: string };

        let textForExtraction = "";

        if (iframeUrl) {
            try {
                const iframeRes = await axios.get(iframeUrl, {
                    headers: { 'User-Agent': 'Mozilla/5.0' },
                    timeout: 10000
                });
                const $iframe = cheerio.load(iframeRes.data);
                $iframe('script, style, nav, header, footer').remove();
                textForExtraction = $iframe('body').text().replace(/\s+/g, ' ').trim();
            } catch (err) {
                console.warn("Failed to fetch iframe:", err);
            }
        }

        if (html) {
            const $ = cheerio.load(html);
            $('script, style, nav, header, footer, .breadcrumb, .drawer-toggles, .notifications, button, noscript, iframe, svg, form, input[type="hidden"], link, meta').remove();
            const mainText = $('body').text().replace(/\s+/g, ' ').trim();
            textForExtraction = textForExtraction ? `${textForExtraction}\n\n${mainText}` : mainText;
        }

        if (!textForExtraction) {
            return reply.code(400).send({ error: "No content to process" });
        }

        textForExtraction = textForExtraction.substring(0, 6000);

        const gptRes = await axios.post(
            "https://api.openai.com/v1/chat/completions",
            {
                model: "gpt-4o-mini",
                messages: [{
                    role: "system",
                    content: "Извлекаешь вопросы из текста. ТОЛЬКО JSON массив."
                }, {
                    role: "user",
                    content: `Найди ВСЕ вопросы. Формат: [{"id":1,"text":"...","options":["A","B"]}]\n\nТекст:\n${textForExtraction}`
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
            if (!Array.isArray(parsed)) parsed = parsed.questions || [];

            questions = parsed
                .filter((q: any) => q?.text?.trim())
                .slice(0, 50)
                .map((q: any, idx: number) => ({
                    id: idx + 1,
                    text: String(q.text).trim(),
                    options: Array.isArray(q.options) ? q.options.slice(0, 8) : undefined
                }));
        } catch (err) {
            return reply.code(400).send({ error: "Failed to parse questions" });
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
                promptLines.push(`${q.id}. ${q.text}`);
                if (q.options) promptLines.push(`Варианты: ${q.options.join(" | ")}`);
            });

            const prompt = `Ответь кратко:\n\n${promptLines.join('\n')}\n\nФормат: "1. ответ"`;

            const gptAnswerRes = await axios.post(
                "https://api.openai.com/v1/chat/completions",
                {
                    model: "gpt-4o-mini",
                    messages: [{
                        role: "system",
                        content: "Отвечаешь кратко. Формат: \"1. ответ\"."
                    }, {
                        role: "user",
                        content: prompt
                    }],
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
                            allAnswers.push({ id: currentId, question: question.text, answer: buffer.trim() });
                        }
                    }
                    currentId = parseInt(match[1]);
                    buffer = match[2];
                } else if (currentId && line.trim()) {
                    buffer += " " + line.trim();
                }
            }

            if (currentId !== null && buffer.trim()) {
                const question = questions.find(q => q.id === currentId);
                if (question) {
                    allAnswers.push({ id: currentId, question: question.text, answer: buffer.trim() });
                }
            }

            await new Promise(resolve => setTimeout(resolve, 500));
        }

        let existing: Answer[] = [];
        try {
            existing = JSON.parse(await fs.readFile(answersPath, "utf-8"));
        } catch {}

        await fs.writeFile(answersPath, JSON.stringify([...existing, ...allAnswers], null, 2));

        return reply.send({ ok: true, count: allAnswers.length, totalQuestions: questions.length });

    } catch (err: any) {
        console.error(err.message);
        return reply.code(500).send({ error: err.message });
    }
});

fastify.register(fastifyStatic, { root: path.join(process.cwd(), "static"), prefix: "/" });

fastify.get("/json", async (req, reply) => {
    try {
        const answers = JSON.parse(await fs.readFile(answersPath, "utf-8"));
        reply.header("Content-Type", "application/json").send(answers);
    } catch {
        reply.code(404).send({ error: "answers.json not found" });
    }
});

fastify.post("/clear-answers", async (req, reply) => {
    try {
        await fs.writeFile(answersPath, "[]", "utf-8");
        return reply.send({ ok: true });
    } catch (err: any) {
        return reply.code(500).send({ error: err.message });
    }
});

fastify.post('/ask-image-gpt', async (req, reply) => {
    try {
        const data = await req.file();
        if (!data) return reply.code(400).send({ error: "No file uploaded" });

        const fileBuffer = await data.toBuffer();

        const { data: { text } } = await Tesseract.recognize(fileBuffer, 'eng+rus', {
            logger: m => console.log(m) // можно удалить или оставить для прогресса
        });

        if (!text.trim()) return reply.code(400).send({ error: "No text detected on the image" });

        const gptRes = await axios.post(
            "https://api.openai.com/v1/chat/completions",
            {
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: "Отвечай на вопросы из текста кратко и точно." },
                    { role: "user", content: text }
                ],
                max_tokens: 1000,
                temperature: 0.2
            },
            { headers: { Authorization: `Bearer ${process.env.OPENAI_KEY}` } }
        );

        const answer = gptRes.data.choices[0].message.content.trim();
        return reply.send({ text: answer });

    } catch (err: any) {
        console.error(err);
        return reply.code(500).send({ error: err.message });
    }
});


const PORT = parseInt(process.env.PORT || "3000");
fastify.listen({ port: PORT, host: "0.0.0.0" })
    .then(() => console.log(`Server running on port ${PORT}`))
    .catch(console.error);