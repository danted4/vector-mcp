export class OllamaEmbedding {
  constructor(model = 'llama2') {
    this.model = model;
    this.baseUrl = process.env.OLLAMA_HOST || 'http://localhost:11434';
  }

  async embed(texts) {
    return Promise.all(texts.map(text => this.getEmbedding(text)));
  }

  async getEmbedding(text) {
    try {
      const cleanText = text.replace(/\n/g, ' ').trim();
      if (!cleanText) {
        throw new Error('Empty text provided');
      }

      const response = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          prompt: cleanText
        })
      });

      if (!response.ok) {
        throw new Error(`Ollama HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      if (!data.embedding || !Array.isArray(data.embedding)) {
        throw new Error('Invalid embedding response from Ollama');
      }
      
      return data.embedding;
    } catch (error) {
      console.error('⚠️ Ollama embedding error:', error.message);
      console.error('🔄 Using fallback dummy embedding');
      // Return a consistent dummy embedding for development
      const seed = this.hashString(text);
      return new Array(4096).fill(0).map((_, i) => Math.sin(seed + i) * 0.1);
    }
  }

  hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash;
  }
}
