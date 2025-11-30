// src/index.js
const express = require('express');
const cors = require('cors');
const censusRoutes = require('./routes/census');
const reportsRoutes = require('./routes/reports');
const aiPopulationRouter = require('./routes/aiPopulation');
const aiUrbanRuralRouter = require('./routes/aiUrbanRural');
const aiInternetRouter = require('./routes/aiInternet');
const chatbotRoutes = require('./routes/chatbot');
const authRoutes = require('./routes/auth');
const vneidAuthRoutes = require('./routes/vneidAuth');
const censusStatusRoutes = require('./routes/censusStatus');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Census routes
app.use('/api/census', censusRoutes);
app.use('/api/census', censusStatusRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/reports', aiPopulationRouter);
app.use('/api/reports', aiUrbanRuralRouter);
app.use('/api/reports', aiInternetRouter);
app.use('/api/chatbot', chatbotRoutes);
app.use('/api/auth', authRoutes.router);
app.use('/api/vneid', vneidAuthRoutes);

app.listen(PORT, () => {
  console.log(`Census API listening on http://localhost:${PORT}`);
});
