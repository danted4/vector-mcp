// ==========================================
// File Indexer - Code Content Processing
// ==========================================
// Handles file discovery, content extraction, chunking, and embedding generation
// Supports delta indexing for efficient updates of large codebases

import fs from 'fs-extra';
import path from 'path';
import { glob } from 'glob';
import crypto from 'crypto';
import { logger } from '../logger/logger.js';

/**
 * File indexer for processing code repositories into searchable vector embeddings
 * Provides full and delta indexing capabilities with content chunking and metadata tracking
 */
export class FileIndexer {
  /**
   * Creates a new FileIndexer instance
   * @param {OllamaEmbedding} embeddingProvider - Service for generating text embeddings
   * @param {MongoVectorStore} vectorStore - Storage backend for documents and vectors
   * @param {JobManager} [jobManager] - Optional job manager for progress tracking
   */
  constructor(embeddingProvider, vectorStore, jobManager = null) {
    this.embeddingProvider = embeddingProvider;
    this.vectorStore = vectorStore;
    this.jobManager = jobManager;
    
    // Default patterns to exclude from indexing
    // Includes common build artifacts, dependencies, and non-code files
    this.defaultExcludes = [
      'node_modules/**',   // Node.js dependencies
      'dist/**',           // Distribution/build outputs
      'build/**',          // Build directories
      '.git/**',           // Git repository data
      '.next/**',          // Next.js build cache
      '.nuxt/**',          // Nuxt.js build cache
      'coverage/**',       // Test coverage reports
      '*.log',             // Log files
      '*.tmp',             // Temporary files
      '*.temp',            // Temporary files
      '.DS_Store',         // macOS metadata
      'Thumbs.db',         // Windows metadata
      '*.min.js',          // Minified JavaScript
      '*.min.css',         // Minified CSS
      'package-lock.json', // NPM lock files
      'yarn.lock',         // Yarn lock files
      'pnpm-lock.yaml',    // PNPM lock files
      '.env*',             // Environment files (may contain secrets)
      'target/**',         // Rust/Java build outputs
      'bin/**',            // Binary directories
      'obj/**'             // Object file directories
    ];
  }

  /**
   * Indexes a directory of files, optionally performing delta-only updates
   * Processes text files into chunks, generates embeddings, and stores in vector database
   * @param {string} dirPath - Directory path to index
   * @param {string} projectId - Unique project identifier
   * @param {string[]} [excludePatterns=[]] - Additional patterns to exclude
   * @param {boolean} [deltaOnly=false] - If true, only process changed files
   * @param {string} [jobId] - Optional job ID for progress tracking
   * @returns {Promise<Object>} Indexing results with statistics
   */
  async indexDirectory(dirPath, projectId, excludePatterns = [], deltaOnly = false, jobId = null) {
    const allExcludes = [...this.defaultExcludes, ...excludePatterns];
    
    // Setup logging method (job-aware or regular logger)
    const logMethod = jobId && this.jobManager ? 
      (msg, level = 'info') => this.jobManager.addJobLog(jobId, msg, level) :
      (msg, level = 'info') => logger.info(msg, { projectId });

    // Setup progress tracking method
    const updateProgress = jobId && this.jobManager ?
      (progress, message) => this.jobManager.updateProgress(jobId, progress, message) :
      (progress, message) => {};

    // Store original path for metadata and logging
    const originalPath = dirPath;
    
    logMethod(`Starting ${deltaOnly ? 'delta ' : ''}indexing for project: ${projectId}`);
    logMethod(`Directory: ${originalPath}${dirPath !== originalPath ? ` (mapped to ${dirPath})` : ''}`);
    logMethod(`Excluding: ${allExcludes.join(', ')}`);
    
    try {
      updateProgress(5, 'Scanning directory...');
      
      // Discover all files in directory, respecting exclude patterns
      const files = await glob('**/*', {
        cwd: dirPath,
        ignore: allExcludes,
        nodir: true,    // Only files, not directories
        dot: false      // Exclude dotfiles by default
      });

      const textFiles = files.filter(f => this.isTextFile(f));
      logMethod(`Found ${files.length} files, ${textFiles.length} text files to ${deltaOnly ? 'check for changes' : 'index'}`);
      
      updateProgress(10, `Found ${textFiles.length} files to process`);
      
      // Load existing file metadata for delta comparison
      let existingFiles = {};
      if (deltaOnly) {
        existingFiles = await this.vectorStore.getExistingFiles(projectId);
        logMethod(`Found ${Object.keys(existingFiles).length} existing files in index`);
        updateProgress(15, 'Loaded existing file metadata');
      }
      
      // Initialize processing statistics
      const documents = [];
      let processed = 0;
      let skipped = 0;    // Files unchanged (delta mode)
      let updated = 0;    // Files modified (delta mode)
      let added = 0;      // New files (delta mode)
      
      // Track current files to identify deletions
      const currentFiles = new Set();
      
      const totalFiles = textFiles.length;
      const startProgress = deltaOnly ? 20 : 15; // Reserve space for metadata loading
      const endProgress = 85; // Reserve space for database operations
      
      let fileIndex = 0;
      for (const file of files) {
        const fullPath = path.join(dirPath, file);
        currentFiles.add(file);
        
        try {
          // Only process text files
          if (this.isTextFile(file)) {
            fileIndex++;
            const stats = await fs.stat(fullPath);
            const content = await fs.readFile(fullPath, 'utf8');
            
            // Skip very large files to avoid memory issues and poor embedding quality
            if (content.length > 1024 * 1024) { // 1MB limit
              logMethod(`Skipping large file: ${file}`, 'warn');
              continue;
            }
            
            const contentHash = this.calculateFileHash(content);
            const fileModTime = stats.mtime;
            
            // Delta indexing: check if file needs processing
            if (deltaOnly && existingFiles[file]) {
              const existing = existingFiles[file];
              
              // Skip if file hasn't changed (same hash, size, and modification time)
              if (existing.contentHash === contentHash && 
                  existing.fileSize === content.length &&
                  new Date(existing.lastModified) >= fileModTime) {
                skipped++;
                continue; // File hasn't changed
              }
              
              // File has changed - remove old chunks before adding new ones
              await this.vectorStore.removeFileChunks(projectId, file);
              updated++;
            } else if (deltaOnly) {
              added++;
            }
            
            // Split content into manageable chunks for embedding
            const chunks = this.chunkContent(content, file);
            
            // Generate embeddings for each chunk
            for (let i = 0; i < chunks.length; i++) {
              const chunk = chunks[i];
              const embedding = await this.embeddingProvider.getEmbedding(chunk.content);
              
              documents.push({
                projectId,
                filePath: file,
                chunkIndex: i,
                totalChunks: chunks.length,
                content: chunk.content,
                embedding,
                metadata: {
                  fileSize: content.length,
                  fileType: path.extname(file),
                  lastModified: fileModTime,
                  contentHash,
                  startLine: chunk.startLine,
                  endLine: chunk.endLine
                }
              });
            }
            
            processed++;
            
            // Update progress proportionally to files processed
            const currentProgress = startProgress + ((fileIndex / totalFiles) * (endProgress - startProgress));
            updateProgress(currentProgress, `Processed ${processed}/${totalFiles} files`);
            
            // Log progress every 10 files to avoid spam
            if (processed % 10 === 0) {
              logMethod(`Processed ${processed}/${totalFiles} files`);
            }
          }
        } catch (error) {
          logMethod(`Error processing file ${file}: ${error.message}`, 'error');
        }
      }
      
      // Handle deleted files in delta mode
      let deleted = 0;
      if (deltaOnly) {
        updateProgress(87, 'Checking for deleted files...');
        const deletedFiles = Object.keys(existingFiles).filter(f => !currentFiles.has(f));
        
        for (const deletedFile of deletedFiles) {
          await this.vectorStore.removeFileChunks(projectId, deletedFile);
          deleted++;
        }
        
        if (deleted > 0) {
          logMethod(`Removed ${deleted} deleted files from index`);
        }
      }
      
      // Save all processed documents to vector store
      if (documents.length > 0) {
        updateProgress(90, 'Saving documents to database...');
        await this.vectorStore.addDocuments(documents);
        logMethod(`Successfully indexed ${documents.length} document chunks for project ${projectId}`, 'success');
      }
      
      // Save project metadata for future delta updates (use original path)
      updateProgress(95, 'Saving project metadata...');
      await this.vectorStore.saveProjectMetadata(projectId, originalPath, excludePatterns);
      
      updateProgress(100, 'Indexing completed successfully');
      
      // Build result object with statistics
      const result = {
        success: true,
        filesProcessed: processed,
        chunksIndexed: documents.length,
        projectId,
        filesTotal: totalFiles
      };
      
      // Add delta statistics if in delta mode
      if (deltaOnly) {
        result.deltaStats = {
          skipped,
          updated,
          added,
          deleted,
          total: totalFiles
        };
        logMethod(`Delta stats: ${skipped} skipped, ${updated} updated, ${added} added, ${deleted} deleted`, 'success');
      }
      
      return result;
      
    } catch (error) {
      logMethod(`Error during indexing: ${error.message}`, 'error');
      throw error;
    }
  }

  /**
   * Calculates MD5 hash of file content for change detection
   * Used in delta indexing to determine if files have been modified
   * @param {string} content - File content to hash
   * @returns {string} MD5 hash in hexadecimal format
   */
  calculateFileHash(content) {
    return crypto.createHash('md5').update(content).digest('hex');
  }

  /**
   * Determines if a file should be processed based on its extension
   * Includes common programming languages and configuration files
   * @param {string} filename - File name to check
   * @returns {boolean} True if file should be indexed
   */
  isTextFile(filename) {
    const textExtensions = [
      // Programming languages
      '.js', '.ts', '.jsx', '.tsx',     // JavaScript/TypeScript
      '.py',                            // Python
      '.java',                          // Java
      '.c', '.cpp', '.h', '.hpp',       // C/C++
      '.cs',                            // C#
      '.php',                           // PHP
      '.rb',                            // Ruby
      '.go',                            // Go
      '.rs',                            // Rust
      '.swift',                         // Swift
      '.kt',                            // Kotlin
      '.scala',                         // Scala
      '.clj',                           // Clojure
      '.r', '.R',                       // R
      '.m',                             // MATLAB/Objective-C
      '.pl',                            // Perl
      
      // Web technologies
      '.html', '.css', '.scss', '.sass', '.less',
      '.vue', '.svelte', '.astro',      // Frontend frameworks
      
      // Data formats
      '.xml', '.json', '.yaml', '.yml',
      '.toml', '.ini', '.conf', '.config',
      
      // Documentation
      '.md', '.txt',
      
      // Database
      '.sql',
      
      // Shell scripts
      '.sh', '.bash', '.zsh', '.fish',
      '.ps1', '.bat',                   // Windows scripts
      
      // Other
      '.dockerfile', '.gitignore', '.env.example',
      '.lock'
    ];
    
    const ext = path.extname(filename).toLowerCase();
    
    // Include files with recognized extensions or no extension (README, Makefile, etc.)
    return textExtensions.includes(ext) || !path.extname(filename);
  }

  /**
   * Splits file content into smaller chunks for better embedding quality
   * Maintains line number information and adds context headers to each chunk
   * @param {string} content - Full file content to chunk
   * @param {string} filename - Source filename for context
   * @returns {Object[]} Array of chunk objects with content and line info
   */
  chunkContent(content, filename) {
    const maxChunkSize = 2000; // Maximum characters per chunk
    const lines = content.split('\n');
    const chunks = [];
    
    let currentChunk = '';
    let startLine = 1;
    let currentLine = 1;
    
    // Process line by line to maintain logical boundaries
    for (const line of lines) {
      // If adding this line would exceed chunk size, save current chunk
      if (currentChunk.length + line.length > maxChunkSize && currentChunk.length > 0) {
        chunks.push({
          content: `File: ${filename}\nLines ${startLine}-${currentLine - 1}:\n\n${currentChunk}`,
          startLine,
          endLine: currentLine - 1
        });
        
        // Start new chunk
        currentChunk = '';
        startLine = currentLine;
      }
      
      currentChunk += line + '\n';
      currentLine++;
    }
    
    // Add final chunk if there's remaining content
    if (currentChunk.trim()) {
      chunks.push({
        content: `File: ${filename}\nLines ${startLine}-${currentLine - 1}:\n\n${currentChunk}`,
        startLine,
        endLine: currentLine - 1
      });
    }
    
    // Ensure we always return at least one chunk, even for empty files
    return chunks.length > 0 ? chunks : [{
      content: `File: ${filename}\n\n${content}`,
      startLine: 1,
      endLine: lines.length
    }];
  }
}