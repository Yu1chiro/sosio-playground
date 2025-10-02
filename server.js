require("dotenv").config();
const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser(process.env.COOKIE_SECRET));
app.use(express.static(path.join(__dirname, "public")));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

const setupDatabase = async () => {
  const client = await pool.connect();
  try {
    console.log("Mengecek dan membuat tabel jika belum ada...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS quizzes (
        id SERIAL PRIMARY KEY,
        question TEXT NOT NULL,
        options JSONB NOT NULL,
        correct_answer VARCHAR(1) NOT NULL,
        image_base64 TEXT,
        image_mimetype TEXT
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS submissions (
        id SERIAL PRIMARY KEY,
        student_name VARCHAR(255) NOT NULL,
        student_absen INTEGER NOT NULL,
        student_class VARCHAR(50) NOT NULL,
        score INTEGER NOT NULL,
        wrong_answers JSONB,
        submitted_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(student_absen, student_class)
      );
    `);
    await client.query(`
        CREATE TABLE IF NOT EXISTS quiz_sessions (
            id SERIAL PRIMARY KEY,
            student_absen INTEGER NOT NULL,
            student_class VARCHAR(50) NOT NULL,
            status VARCHAR(50) NOT NULL DEFAULT 'active',
            last_updated TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(student_absen, student_class)
        );
    `);
    console.log("✅ Skema database sudah sesuai.");
  } catch (err) {
    if (!err.message.includes("does not exist") && !err.message.includes("already exists")) {
        console.error("❌ Gagal setup database:", err);
    }
  } finally {
    client.release();
  }
};

const checkAuth = (req, res, next) => {
    if (req.signedCookies.session_token === "admin_logged_in") {
        return next();
    }
    res.redirect("/login");
};

app.get("/login", (req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));

app.post("/api/login", (req, res) => {
    const { username, password } = req.body;
    if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
        res.cookie("session_token", "admin_logged_in", {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            maxAge: 7 * 24 * 60 * 60 * 1000,
            signed: true,
        });
        return res.status(200).json({ success: true, message: "Login berhasil", redirectUrl: "/dashboard" });
    }
    return res.status(401).json({ success: false, message: "Username atau password salah." });
});

app.get("/dashboard", checkAuth, (req, res) => res.sendFile(path.join(__dirname, "public", "dashboard.html")));

app.post("/api/logout", (req, res) => {
    res.clearCookie("session_token");
    res.status(200).json({ success: true, message: "Logout berhasil", redirectUrl: "/login" });
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "quiz.html")));
app.get("/statistik", (req, res) => res.sendFile(path.join(__dirname, "public", "statistik.html")));
app.get("/monitor", checkAuth, (req, res) => res.sendFile(path.join(__dirname, "public", "monitor.html")));

app.get("/api/quizzes", checkAuth, async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT * FROM quizzes ORDER BY id ASC");
        res.json(rows);
    } catch (err) {
        res.status(500).json({ success: false, message: "Server error", error: err.message });
    }
});

app.post("/api/quizzes", checkAuth, async (req, res) => {
    const { question, options, correct_answer, image_base64, image_mimetype } = req.body;
    try {
        const newQuiz = await pool.query(
            "INSERT INTO quizzes (question, options, correct_answer, image_base64, image_mimetype) VALUES ($1, $2, $3, $4, $5) RETURNING id",
            [question, options, correct_answer, image_base64, image_mimetype]
        );
        res.status(201).json({ success: true, data: newQuiz.rows[0] });
    } catch (err) {
        console.error("Error inserting quiz:", err);
        res.status(500).json({ success: false, message: "Gagal menambah soal", error: err.message });
    }
});

app.put("/api/quizzes/:id", checkAuth, async (req, res) => {
    const { id } = req.params;
    const { question, options, correct_answer, image_base64, image_mimetype } = req.body;
    try {
        const updatedQuiz = await pool.query(
            "UPDATE quizzes SET question = $1, options = $2, correct_answer = $3, image_base64 = $4, image_mimetype = $5 WHERE id = $6 RETURNING id",
            [question, options, correct_answer, image_base64, image_mimetype, id]
        );
        if (updatedQuiz.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Soal tidak ditemukan." });
        }
        res.status(200).json({ success: true, data: updatedQuiz.rows[0] });
    } catch (err) {
        console.error("Error updating quiz:", err);
        res.status(500).json({ success: false, message: "Gagal mengupdate soal", error: err.message });
    }
});

app.delete("/api/quizzes/:id", checkAuth, async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query("DELETE FROM quizzes WHERE id = $1", [id]);
        res.status(200).json({ success: true, message: "Soal berhasil dihapus." });
    } catch (err) {
        res.status(500).json({ success: false, message: "Gagal menghapus soal", error: err.message });
    }
});

app.get("/api/submissions", checkAuth, async (req, res) => {
    const { kelas } = req.query;
    try {
        let query = "SELECT * FROM submissions";
        const params = [];
        if (kelas && kelas !== 'semua') {
            query += " WHERE student_class = $1";
            params.push(kelas);
        }
        query += " ORDER BY student_class ASC, score DESC";
        const { rows } = await pool.query(query, params);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ success: false, message: "Server error", error: err.message });
    }
});

app.delete("/api/submissions/:absen/:kelas", checkAuth, async (req, res) => {
    const { absen, kelas } = req.params;
    try {
        await pool.query("DELETE FROM submissions WHERE student_absen = $1 AND student_class = $2", [absen, kelas]);
        res.status(200).json({ success: true, message: "Data nilai siswa berhasil dihapus." });
    } catch (err) {
        res.status(500).json({ success: false, message: "Gagal menghapus data siswa", error: err.message });
    }
});

app.get("/api/last-submission", async (req, res) => {
    const { absen, kelas } = req.query;
    if (!absen || !kelas) {
        return res.status(400).json({ message: "Nomor absen dan kelas dibutuhkan." });
    }
    try {
        const submissionRes = await pool.query(
            "SELECT * FROM submissions WHERE student_absen = $1 AND student_class = $2 ORDER BY submitted_at DESC LIMIT 1",
            [absen, kelas]
        );
        if (submissionRes.rows.length === 0) {
            return res.status(404).json({ message: "Data submission tidak ditemukan." });
        }
        const lastSubmission = submissionRes.rows[0];
        const quizzesRes = await pool.query("SELECT * FROM quizzes ORDER BY id ASC");
        const allQuizzes = quizzesRes.rows;

        const wrongAnswersMap = new Map();
        if (lastSubmission.wrong_answers) {
            lastSubmission.wrong_answers.forEach(wa => {
                wrongAnswersMap.set(wa.questionId, wa.selectedAnswer);
            });
        }

        const details = allQuizzes.map(q => {
            const userAnswer = wrongAnswersMap.has(q.id) ? wrongAnswersMap.get(q.id) : q.correct_answer;
            return {
                question: q.question,
                options: q.options,
                image_base64: q.image_base64,
                image_mimetype: q.image_mimetype,
                userAnswer: userAnswer,
                correctAnswer: q.correct_answer,
                isCorrect: !wrongAnswersMap.has(q.id)
            };
        });

        res.json({
            student: { student_name: lastSubmission.student_name },
            score: lastSubmission.score,
            date: lastSubmission.submitted_at,
            details: details
        });
    } catch (err) {
        console.error("Error fetching last submission:", err);
        res.status(500).json({ message: "Server error" });
    }
});

app.post("/api/check-absen", async (req, res) => {
    const { student_absen, student_class } = req.body;
    try {
        const { rows } = await pool.query(
            "SELECT id FROM submissions WHERE student_absen = $1 AND student_class = $2",
            [student_absen, student_class]
        );
        if (rows.length > 0) {
            return res.status(409).json({ exists: true, message: `Nilai untuk absen ${student_absen} di kelas ${student_class} sudah ada di sistem kamu hanya bisa menyelesaikan quiz 1 kali! Silahkan hubungi guru jika ingin melakukan review/latihan soal` });
        }
        res.status(200).json({ exists: false });
    } catch (err) {
        res.status(500).json({ success: false, message: "Server error", error: err.message });
    }
});

app.get("/api/quiz-questions", async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT id, question, options, image_base64, image_mimetype, correct_answer FROM quizzes ORDER BY id ASC");
        res.json(rows);
    } catch (err) {
        res.status(500).json({ success: false, message: "Server error", error: err.message });
    }
});

app.post("/api/check-answer", async (req, res) => {
    const { questionId, userAnswer } = req.body;
    if (!questionId || !userAnswer) {
        return res.status(400).json({ success: false, message: "Membutuhkan ID Soal dan Jawaban Pengguna." });
    }
    try {
        const { rows } = await pool.query("SELECT correct_answer FROM quizzes WHERE id = $1", [questionId]);
        if (rows.length === 0) {
            return res.status(404).json({ success: false, message: "Soal tidak ditemukan." });
        }
        const correctAnswer = rows[0].correct_answer;
        const isCorrect = (userAnswer.toLowerCase() === correctAnswer.toLowerCase());
        res.status(200).json({ success: true, isCorrect: isCorrect, correctAnswer: correctAnswer });
    } catch (err) {
        res.status(500).json({ success: false, message: "Server error", error: err.message });
    }
});

app.post("/api/submit-quiz", async (req, res) => {
    const { student_name, student_absen, student_class, answers } = req.body;
    try {
        const { rows: quizzes } = await pool.query("SELECT id, correct_answer FROM quizzes");
        const answerKey = new Map(quizzes.map(q => [q.id, q.correct_answer]));

        let correctCount = 0;
        const wrong_answers = [];

        for (const userAnswer of answers) {
            const correctAnswer = answerKey.get(userAnswer.questionId);
            if (userAnswer.answer && correctAnswer && userAnswer.answer.toLowerCase() === correctAnswer.toLowerCase()) {
                correctCount++;
            } else {
                wrong_answers.push({
                    questionId: userAnswer.questionId,
                    selectedAnswer: userAnswer.answer || "Tidak Dijawab",
                    correctAnswer: correctAnswer
                });
            }
        }

        const totalQuestions = quizzes.length;
        const finalScore = totalQuestions > 0 ? Math.round((correctCount / totalQuestions) * 100) : 0;

        await pool.query(
            "INSERT INTO submissions (student_name, student_absen, student_class, score, wrong_answers) VALUES ($1, $2, $3, $4, $5)",
            [student_name, student_absen, student_class, finalScore, JSON.stringify(wrong_answers)]
        );
        res.status(201).json({ success: true, message: "Jawaban berhasil disimpan!", score: finalScore });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ success: false, message: 'Nomor absen ini sudah digunakan di kelas yang sama.' });
        }
        console.error("Error saat submit kuis:", err.message);
        res.status(500).json({ success: false, message: "Gagal menyimpan jawaban", error: err.message });
    }
});

app.post("/api/session/start", async (req, res) => {
    const { student_absen, student_class } = req.body;
    try {
        await pool.query(
            `INSERT INTO quiz_sessions (student_absen, student_class, status)
             VALUES ($1, $2, 'active')
             ON CONFLICT (student_absen, student_class)
             DO UPDATE SET status = 'active', last_updated = NOW()`,
            [student_absen, student_class]
        );
        res.status(200).json({ success: true });
    } catch (err) {
        console.error("Error starting session:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

app.post("/api/session/block", async (req, res) => {
    const { student_absen, student_class } = req.body;
    try {
        await pool.query(
            "UPDATE quiz_sessions SET status = 'blocked', last_updated = NOW() WHERE student_absen = $1 AND student_class = $2",
            [student_absen, student_class]
        );
        res.status(200).json({ success: true });
    } catch (err) {
        console.error("Error blocking session:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

app.post("/api/session/unblock", checkAuth, async (req, res) => {
    const { student_absen, student_class } = req.body;
    try {
        await pool.query(
            "UPDATE quiz_sessions SET status = 'active', last_updated = NOW() WHERE student_absen = $1 AND student_class = $2",
            [student_absen, student_class]
        );
        res.status(200).json({ success: true, message: "Siswa berhasil di-unblock." });
    } catch (err) {
        console.error("Error unblocking session:", err);
        res.status(500).json({ success: false, message: "Gagal unblock siswa." });
    }
});

app.get("/api/session/status", async (req, res) => {
    const { absen, kelas } = req.query;
    try {
        const { rows } = await pool.query(
            "SELECT status FROM quiz_sessions WHERE student_absen = $1 AND student_class = $2",
            [absen, kelas]
        );
        if (rows.length === 0) {
            return res.status(404).json({ status: 'not_found' });
        }
        res.json({ status: rows[0].status });
    } catch (err) {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

app.get("/api/sessions", checkAuth, async (req, res) => {
    const { kelas } = req.query;
    try {
        let queryText = `
            SELECT 
                s.student_absen, 
                s.student_class, 
                sub.student_name, 
                s.status
            FROM quiz_sessions s
            LEFT JOIN submissions sub ON s.student_absen = sub.student_absen AND s.student_class = sub.student_class
        `;
        const params = [];
        if (kelas && kelas !== 'semua') {
            queryText += ' WHERE s.student_class = $1';
            params.push(kelas);
        }
        queryText += ' ORDER BY s.student_class, s.student_absen';

        const { rows } = await pool.query(queryText, params);
        res.json(rows);
    } catch (err) {
        console.error("Error fetching sessions:", err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.listen(PORT, async () => {
    await setupDatabase();
    console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
});