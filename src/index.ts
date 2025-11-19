import Fastify from "fastify";
import axios from "axios";
import fs from "fs/promises";
import fastifyStatic from "@fastify/static";
import path from "path";

const fastify = Fastify({ logger: true });

// POST /process-html
fastify.post("/process-html", async (req, reply) => {
    try {
        const { html } = req.body as { html?: string };
        if (!html) return reply.code(400).send({ error: "html required" });

        // GPT извлекает вопросы
        const gptRes = await axios.post(
            "https://api.openai.com/v1/chat/completions",
            {
                model: "gpt-4o-mini",
                messages: [{
                    role: "user",
                    content: `Извлеки вопросы из HTML. Верни ТОЛЬКО JSON:\n{"questions":[{"id":1,"text":"...","options":["A","B"]}]}\n\nHTML:\n${html}`
                }]
            },
            { headers: { Authorization: `Bearer ${process.env.OPENAI_KEY}` } }
        );

        const { questions } = JSON.parse(gptRes.data.choices[0].message.content.trim());

        // Claude отвечает
        let prompt = "Ответь на вопросы (формат: 1. ответ):\n\n";
        questions.forEach(q => {
            prompt += `${q.id}. ${q.text}\n`;
            if (q.options) prompt += `Варианты: ${q.options.join(", ")}\n`;
        });

        const gptAnswerRes = await axios.post(
            "https://api.openai.com/v1/chat/completions",
            {
                model: "gpt-4o-mini",
                messages: [
                    {
                        role: "user",
                        content: prompt
                    }
                ],
                max_tokens: 2000
            },
            {
                headers: {
                    "Authorization": `Bearer ${process.env.OPENAI_KEY}`,
                    "Content-Type": "application/json"
                }
            }
        );

        const rawAnswers = gptAnswerRes.data.choices[0].message.content.trim();

        const answers = [];
        let currentId = null, buffer = "";
        rawAnswers.split("\n").forEach(line => {
            const match = line.match(/^(\d+)[).:\s]+(.+)/);
            if (match) {
                if (currentId) {
                    answers.push({
                        id: currentId,
                        question: questions.find(q => q.id == currentId)?.text || "",
                        answer: buffer.trim()
                    });
                }
                currentId = parseInt(match[1]);
                buffer = match[2];
            } else if (currentId) {
                buffer += " " + line;
            }
        });
        if (currentId) {
            answers.push({
                id: currentId,
                question: questions.find(q => q.id == currentId)?.text || "",
                answer: buffer.trim()
            });
        }

        let existing: any[] = [];
        try { existing = JSON.parse(await fs.readFile("./answers.json", "utf-8")); } catch {}
        await fs.writeFile("./answers.json", JSON.stringify([...existing, ...answers], null, 2));

        return reply.send({ ok: true, count: answers.length });
    } catch (err: any) {
        console.error(err);
        return reply.code(500).send({ error: err.message });
    }
});

fastify.register(fastifyStatic, { root: path.join(process.cwd(), "static"), prefix: "/" });
fastify.get("/json", async (req, reply) => {
    try {
        const data = await fs.readFile("./answers.json", "utf-8");
        reply.header("Content-Type", "application/json").send(data);
    } catch { reply.code(404).send({ error: "answers.json not found" }); }
});

const PORT = parseInt(process.env.PORT || "3000");
fastify.listen({ port: PORT, host: "0.0.0.0" })
    .then(() => console.log(`Server running on port ${PORT}`))
    .catch(console.error);
