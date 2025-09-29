const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3001;

let dashboards = {};
let sessions = {};

app.use(cors());
app.use(bodyParser.json());

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.sendStatus(401);

  jwt.verify(token, 'SECRET_KEY', (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

app.post('/oauth/token', (req, res) => {
  const { username, password } = req.body;
  const user = { id: uuidv4(), name: username };

  const accessToken = jwt.sign(user, 'SECRET_KEY', { expiresIn: '1h' });
  res.json({ accessToken });
});

app.get('/dashboards', authenticateToken, (req, res) => {
  res.json(Object.values(dashboards));
});

app.post('/dashboards', authenticateToken, (req, res) => {
  const id = req.body.id || uuidv4();
  dashboards[id] = { ...req.body, id };
  res.json(dashboards[id]);
});

app.get('/dashboards/history', authenticateToken, (req, res) => {
  res.json(Object.values(dashboards));
});

app.post('/dashboards/rollback', authenticateToken, (req, res) => {
  const { id } = req.body;
  if (dashboards[id]) {
    res.json(dashboards[id]);
  } else {
    res.status(404).json({ error: 'Dashboard not found' });
  }
});

app.get('/admin/sessions', authenticateToken, (req, res) => {
  res.json(sessions);
});

app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});
