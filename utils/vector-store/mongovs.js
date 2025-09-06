// ==========================================
// MongoDB Vector Store
// ==========================================
// Provides vector storage and similarity search capabilities using MongoDB
// Handles document storage, retrieval, and project management operations

import { ObjectId } from 'mongodb';

/**
 * Calculates cosine similarity between two vectors
 * Used for semantic similarity scoring in vector search operations
 * @param {number[]} a - First vector
 * @param {number[]} b - Second vector
 * @returns {number} Cosine similarity score between 0 and 1
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) {
    return 0;
  }
  
  // Calculate dot product
  const dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
  
  // Calculate vector magnitudes
  const normA = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
  const normB = Math.sqrt(b.reduce((sum, v) => sum + v * v, 0));
  
  // Return cosine similarity
  return dot / (normA * normB);
}

/**
 * MongoDB-based vector store for storing and searching document embeddings
 * Provides project-scoped storage with metadata support and similarity search
 */
export class MongoVectorStore {
  /**
   * Creates a new MongoVectorStore instance
   * @param {Collection} collection - MongoDB collection for documents
   * @param {Db} [db] - MongoDB database instance (optional, derived from collection)
   */
  constructor(collection, db = null) {
    this.collection = collection;
    this.db = db || collection.db;
  }

  /**
   * Adds multiple documents with embeddings to the vector store
   * Handles document structure normalization and metadata storage
   * @param {Object[]} docs - Array of document objects to add
   * @param {string} [docs[].id] - Optional document ID (auto-generated if not provided)
   * @param {string} docs[].projectId - Project identifier for grouping
   * @param {string} docs[].filePath - Source file path
   * @param {number} [docs[].chunkIndex=0] - Chunk index within file
   * @param {number} [docs[].totalChunks=1] - Total chunks in file
   * @param {string} docs[].content - Document text content
   * @param {number[]} docs[].embedding - Vector embedding
   * @param {Object} [docs[].metadata={}] - Additional metadata
   * @returns {Promise<void>}
   */
  async addDocuments(docs) {
    const toInsert = docs.map((doc) => ({
      _id: doc.id ? new ObjectId(doc.id) : new ObjectId(),
      projectId: doc.projectId,
      filePath: doc.filePath,
      chunkIndex: doc.chunkIndex || 0,
      totalChunks: doc.totalChunks || 1,
      content: doc.content || doc.text, // Support both content and text fields
      embedding: doc.embedding,
      metadata: doc.metadata || {},
      createdAt: new Date(),
    }));
    
    await this.collection.insertMany(toInsert);
  }

  /**
   * Performs vector similarity search across stored documents
   * Supports project-scoped filtering and returns top-K most similar results
   * @param {number[]} queryEmbedding - Query vector to search for
   * @param {number} [topK=3] - Number of top results to return
   * @param {string} [projectId] - Optional project filter
   * @returns {Promise<Object[]>} Array of search results with similarity scores
   */
  async search(queryEmbedding, topK = 3, projectId = null) {
    // Build filter query
    const filter = { embedding: { $exists: true } };
    if (projectId) {
      filter.projectId = projectId;
    }
    
    // Retrieve all matching documents
    const allDocs = await this.collection.find(filter).toArray();
    
    // Calculate similarity scores for all documents
    const scored = allDocs.map(doc => ({
      id: doc._id.toString(),
      projectId: doc.projectId,
      filePath: doc.filePath,
      content: doc.content,
      metadata: doc.metadata,
      score: cosineSimilarity(queryEmbedding, doc.embedding),
    }));
    
    // Sort by similarity score (highest first) and return top-K
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /**
   * Retrieves all indexed projects with their statistics and metadata
   * Combines project metadata with document counts for comprehensive project info
   * @returns {Promise<Object[]>} Array of project objects with statistics
   */
  async getProjects() {
    // Try to get from projects metadata collection first
    const projectsCollection = this.db.collection('project_metadata');
    const projectMetadata = await projectsCollection.find({}).toArray();
    
    if (projectMetadata.length > 0) {
      // Get document counts and merge with metadata
      const projectStats = await Promise.all(
        projectMetadata.map(async (meta) => {
          const count = await this.collection.countDocuments({ projectId: meta.projectId });
          return {
            projectId: meta.projectId,
            documentCount: count,
            lastModified: meta.lastIndexed || meta.createdAt,
            directoryPath: meta.directoryPath,
            excludePatterns: meta.excludePatterns || [],
            createdAt: meta.createdAt,
            lastIndexed: meta.lastIndexed
          };
        })
      );
      return projectStats;
    }
    
    // Fallback to old method for backward compatibility with legacy projects
    const projects = await this.collection.distinct('projectId');
    const projectStats = await Promise.all(
      projects.map(async (projectId) => {
        const count = await this.collection.countDocuments({ projectId });
        const sample = await this.collection.findOne({ projectId });
        return {
          projectId,
          documentCount: count,
          lastModified: sample?.createdAt || new Date(),
          directoryPath: null, // Unknown for legacy projects
          excludePatterns: []
        };
      })
    );
    return projectStats;
  }

  /**
   * Gets detailed statistics for a specific project
   * Returns document counts, file counts, and file listings
   * @param {string} projectId - Project ID to get statistics for
   * @returns {Promise<Object>} Project statistics object
   */
  async getProjectStats(projectId) {
    const totalDocs = await this.collection.countDocuments({ projectId });
    const files = await this.collection.distinct('filePath', { projectId });
    
    return {
      projectId,
      totalDocuments: totalDocs,
      totalFiles: files.length,
      files
    };
  }

  /**
   * Retrieves metadata for existing files in a project
   * Used for delta indexing to determine which files have changed
   * @param {string} projectId - Project ID to query
   * @returns {Promise<Object>} Map of file paths to their metadata
   */
  async getExistingFiles(projectId) {
    const pipeline = [
      { $match: { projectId } },
      {
        $group: {
          _id: '$filePath',
          fileSize: { $first: '$metadata.fileSize' },
          lastModified: { $first: '$metadata.lastModified' },
          contentHash: { $first: '$metadata.contentHash' }
        }
      }
    ];
    
    const results = await this.collection.aggregate(pipeline).toArray();
    const fileMap = {};
    
    // Convert aggregation results to a convenient lookup map
    for (const result of results) {
      fileMap[result._id] = {
        fileSize: result.fileSize,
        lastModified: result.lastModified,
        contentHash: result.contentHash
      };
    }
    
    return fileMap;
  }

  /**
   * Removes all document chunks for a specific file from a project
   * Used during delta updates when files are modified or deleted
   * @param {string} projectId - Project ID
   * @param {string} filePath - File path to remove chunks for
   * @returns {Promise<number>} Number of documents deleted
   */
  async removeFileChunks(projectId, filePath) {
    const result = await this.collection.deleteMany({ projectId, filePath });
    return result.deletedCount;
  }

  /**
   * Saves or updates project metadata including directory path and exclude patterns
   * Used to store indexing configuration for future delta updates
   * @param {string} projectId - Project identifier
   * @param {string} directoryPath - Directory that was indexed
   * @param {string[]} [excludePatterns=[]] - Patterns that were excluded during indexing
   * @returns {Promise<Object>} Saved metadata object
   */
  async saveProjectMetadata(projectId, directoryPath, excludePatterns = []) {
    const projectsCollection = this.db.collection('project_metadata');
    
    const metadata = {
      projectId,
      directoryPath,
      excludePatterns,
      lastIndexed: new Date(),
      updatedAt: new Date()
    };

    // Upsert metadata (create if doesn't exist, update if it does)
    await projectsCollection.updateOne(
      { projectId },
      { 
        $set: metadata,
        $setOnInsert: { createdAt: new Date() }
      },
      { upsert: true }
    );

    return metadata;
  }

  /**
   * Retrieves stored metadata for a project
   * Returns directory path, exclude patterns, and indexing timestamps
   * @param {string} projectId - Project ID to get metadata for
   * @returns {Promise<Object|null>} Project metadata or null if not found
   */
  async getProjectMetadata(projectId) {
    const projectsCollection = this.db.collection('project_metadata');
    return await projectsCollection.findOne({ projectId });
  }

  /**
   * Completely removes a project and all its associated data
   * Deletes both document embeddings and project metadata
   * @param {string} projectId - Project ID to delete
   * @returns {Promise<number>} Number of documents deleted
   */
  async deleteProject(projectId) {
    // Delete all documents for the project
    const docsResult = await this.collection.deleteMany({ projectId });
    
    // Delete project metadata
    const projectsCollection = this.db.collection('project_metadata');
    await projectsCollection.deleteOne({ projectId });
    
    return docsResult.deletedCount;
  }
}