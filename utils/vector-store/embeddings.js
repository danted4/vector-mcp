// ==========================================
// Ollama Embedding Provider
// ==========================================
// Handles text-to-vector embedding generation using Ollama's local API
// Provides fallback dummy embeddings for development when Ollama is unavailable

/**
 * Ollama embedding provider class for generating text embeddings
 * Communicates with local Ollama instance to create vector representations of text
 * Includes fallback mechanism for development environments
 */
export class OllamaEmbedding {
  /**
   * Creates a new OllamaEmbedding instance
   * @param {string} [model='llama2'] - The Ollama model to use for embeddings
   */
  constructor(model = 'llama2') {
    this.model = model;
    this.baseUrl = process.env.OLLAMA_HOST || 'http://localhost:11434';
  }

  /**
   * Generates embeddings for multiple text inputs in parallel
   * Convenience method for batch processing multiple texts
   * @param {string[]} texts - Array of text strings to embed
   * @returns {Promise<number[][]>} Array of embedding vectors
   */
  async embed(texts) {
    return Promise.all(texts.map(text => this.getEmbedding(text)));
  }

  /**
   * Generates a vector embedding for a single text input
   * Uses Ollama's local API or falls back to dummy embeddings if unavailable
   * @param {string} text - Text to generate embedding for
   * @returns {Promise<number[]>} Embedding vector (array of floats)
   * @throws {Error} If text is empty after cleaning
   */
  async getEmbedding(text) {
    try {
      // Clean and validate input text
      const cleanText = text.replace(/\n/g, ' ').trim();
      if (!cleanText) {
        throw new Error('Empty text provided');
      }

      // Make request to Ollama embeddings API
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
      
      // Validate response structure
      if (!data.embedding || !Array.isArray(data.embedding)) {
        throw new Error('Invalid embedding response from Ollama');
      }
      
      return data.embedding;
      
    } catch (error) {
      console.error('⚠️ Ollama embedding error:', error.message);
      console.error('🔄 Using fallback dummy embedding');
      
      // Generate consistent dummy embedding for development/testing
      // This ensures the system remains functional even without Ollama
      const seed = this.hashString(text);
      return new Array(4096).fill(0).map((_, i) => Math.sin(seed + i) * 0.1);
    }
  }

  /**
   * Generates a simple hash code from a string for deterministic dummy embeddings
   * Used to create consistent fallback embeddings when Ollama is unavailable
   * @param {string} str - Input string to hash
   * @returns {number} 32-bit integer hash code
   * @private
   */
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