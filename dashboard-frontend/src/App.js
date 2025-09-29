import React, { useState, useEffect } from 'react';
import axios from 'axios';

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || 'http://localhost:3001';

function App() {
  const [token, setToken] = useState(null);
  const [dashboards, setDashboards] = useState([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const login = async () => {
    try {
      const response = await axios.post(`${BACKEND_URL}/oauth/token`, { username, password });
      setToken(response.data.accessToken);
    } catch (error) {
      alert('Erro no login');
    }
  };

  const fetchDashboards = async () => {
    try {
      const response = await axios.get(`${BACKEND_URL}/dashboards`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setDashboards(response.data);
    } catch (error) {
      alert('Erro ao buscar dashboards');
    }
  };

  useEffect(() => {
    if (token) {
      fetchDashboards();
    }
  }, [token]);

  if (!token) {
    return (
      <div style={{ margin: 20 }}>
        <h2>Login</h2>
        <input placeholder="Usuário" value={username} onChange={(e) => setUsername(e.target.value)} />
        <br />
        <input
          placeholder="Senha"
          value={password}
          type="password"
          onChange={(e) => setPassword(e.target.value)}
        />
        <br />
        <button onClick={login}>Entrar</button>
      </div>
    );
  }

  return (
    <div style={{ margin: 20 }}>
      <h2>Dashboards</h2>
      <ul>
        {dashboards.map((d) => (
          <li key={d.id}>{JSON.stringify(d)}</li>
        ))}
      </ul>
    </div>
  );
}

export default App;
