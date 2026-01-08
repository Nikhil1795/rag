import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import './App.css';

function App() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef(null);

  // useEffect(() => {
  //   // Load PDF on mount
  //   // axios.get('http://localhost:5000/load-pdf').then(() => {
  //     axios.get('/api/chat').then(() => {
  //     // setMessages([{ sender: 'bot', text: 'PDF loaded! Ask away.' }]);
  //   }).catch(err => console.error(err));
  // }, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const sendMessage = async () => {
    if (!input.trim()) return;
    const userMsg = { sender: 'user', text: input };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    try {
      // const res = await axios.post('http://localhost:5000/chat', { message: input });
      const res = await axios.post('/api/chat', { message: input });
      setMessages(prev => [...prev, { sender: 'bot', text: res.data.response }]);
    } catch (err) {
      setMessages(prev => [...prev, { sender: 'bot', text: 'Error: ' + err.message }]);
    }
    setLoading(false);
  };

  return (
    <div className="app">
      <div className="chat-container">
        <div className="messages">
          {messages.map((msg, i) => (
            <div key={i} className={`message ${msg.sender}`}>
              <div className="bubble">{msg.text}</div>
            </div>
          ))}
          {loading && <div className="message bot"><div className="bubble">Typing...</div></div>}
          <div ref={messagesEndRef} />
        </div>
        <div className="input-area">
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyPress={e => e.key === 'Enter' && sendMessage()}
            placeholder="Type your question..."
            disabled={loading}
          />
          <button onClick={sendMessage} disabled={loading}>Send</button>
        </div>
      </div>
    </div>
  );
}

export default App;