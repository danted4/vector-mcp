import { ObjectId } from 'mongodb';

// Simple cosine similarity helper
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) {
    return 0;
  }
  const dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
  const normA = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
  const normB = Math.sqrt(b.reduce((sum, v) => sum + v * v, 0));
  return dot / (normA * normB);
}

export class MongoVectorStore {
  constructor(collection, db = null) {
    this.collection = collection;
    this.db = db || collection.db;
  }

  async addDocuments(docs) {
    const toInsert = docs.map((doc) => ({
      _id: doc.id ? new ObjectId(doc.id) : new ObjectId(),
      projectId: doc.projectId,
      filePath: doc.filePath,
      chunkIndex: doc.chunkIndex || 0,
      totalChunks: doc.totalChunks || 1,
      content: doc.content || doc.text, // Support both content and text
      embedding: doc.embedding,
      metadata: doc.metadata || {},
      createdAt: new Date(),
    }));
    await this.collection.insertMany(toInsert);
  }

  // Enhanced search with project filtering
  async search(queryEmbedding, topK = 3, projectId = null) {
    const filter = { embedding: { $exists: true } };
    if (projectId) {
      filter.projectId = projectId;
    }
    
    const allDocs = await this.collection.find(filter).toArray();
    const scored = allDocs.map(doc => ({
      id: doc._id.toString(),
      projectId: doc.projectId,
      filePath: doc.filePath,
      content: doc.content,
      metadata: doc.metadata,
      score: cosineSimilarity(queryEmbedding, doc.embedding),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

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
    
    // Fallback to old method for backward compatibility
    const projects = await this.collection.distinct('projectId');
    const projectStats = await Promise.all(
      projects.map(async (projectId) => {
        const count = await this.collection.countDocuments({ projectId });
        const sample = await this.collection.findOne({ projectId });
        return {
          projectId,
          documentCount: count,
          lastModified: sample?.createdAt || new Date(),
          directoryPath: null, // Unknown for old projects
          excludePatterns: []
        };
      })
    );
    return projectStats;
  }



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
    
    for (const result of results) {
      fileMap[result._id] = {
        fileSize: result.fileSize,
        lastModified: result.lastModified,
        contentHash: result.contentHash
      };
    }
    
    return fileMap;
  }

  async removeFileChunks(projectId, filePath) {
    const result = await this.collection.deleteMany({ projectId, filePath });
    return result.deletedCount;
  }

  async saveProjectMetadata(projectId, directoryPath, excludePatterns = []) {
    const projectsCollection = this.db.collection('project_metadata');
    
    const metadata = {
      projectId,
      directoryPath,
      excludePatterns,
      lastIndexed: new Date(),
      updatedAt: new Date()
    };

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

  async getProjectMetadata(projectId) {
    const projectsCollection = this.db.collection('project_metadata');
    return await projectsCollection.findOne({ projectId });
  }

  async deleteProject(projectId) {
    // Delete documents
    const docsResult = await this.collection.deleteMany({ projectId });
    
    // Delete metadata
    const projectsCollection = this.db.collection('project_metadata');
    await projectsCollection.deleteOne({ projectId });
    
    return docsResult.deletedCount;
  }
}