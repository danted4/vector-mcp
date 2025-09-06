import fs from 'fs-extra';
import path from 'path';
import { glob } from 'glob';
import crypto from 'crypto';
import { logger } from '../../Logger.js';

export class FileIndexer {
  constructor(embeddingProvider, vectorStore, jobManager = null) {
    this.embeddingProvider = embeddingProvider;
    this.vectorStore = vectorStore;
    this.jobManager = jobManager;
    
    // Common patterns to exclude
    this.defaultExcludes = [
      'node_modules/**',
      'dist/**',
      'build/**',
      '.git/**',
      '.next/**',
      '.nuxt/**',
      'coverage/**',
      '*.log',
      '*.tmp',
      '*.temp',
      '.DS_Store',
      'Thumbs.db',
      '*.min.js',
      '*.min.css',
      'package-lock.json',
      'yarn.lock',
      'pnpm-lock.yaml',
      '.env*',
      'target/**',
      'bin/**',
      'obj/**'
    ];
  }

  async indexDirectory(dirPath, projectId, excludePatterns = [], deltaOnly = false, jobId = null) {
    const allExcludes = [...this.defaultExcludes, ...excludePatterns];
    
    const logMethod = jobId && this.jobManager ? 
      (msg, level = 'info') => this.jobManager.addJobLog(jobId, msg, level) :
      (msg, level = 'info') => logger.info(msg, { projectId });

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
      
      // Get all files excluding patterns
      const files = await glob('**/*', {
        cwd: dirPath,
        ignore: allExcludes,
        nodir: true,
        dot: false
      });

      const textFiles = files.filter(f => this.isTextFile(f));
      logMethod(`Found ${files.length} files, ${textFiles.length} text files to ${deltaOnly ? 'check for changes' : 'index'}`);
      
      updateProgress(10, `Found ${textFiles.length} files to process`);
      
      let existingFiles = {};
      if (deltaOnly) {
        // Get existing file metadata for delta comparison
        existingFiles = await this.vectorStore.getExistingFiles(projectId);
        logMethod(`Found ${Object.keys(existingFiles).length} existing files in index`);
        updateProgress(15, 'Loaded existing file metadata');
      }
      
      const documents = [];
      let processed = 0;
      let skipped = 0;
      let updated = 0;
      let added = 0;
      
      // Track files we've seen to identify deleted files
      const currentFiles = new Set();
      
      const totalFiles = textFiles.length;
      const startProgress = deltaOnly ? 20 : 15; // Leave room for final steps
      const endProgress = 85; // Leave room for saving and cleanup
      
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
            
            // Skip very large files (>1MB)
            if (content.length > 1024 * 1024) {
              logMethod(`Skipping large file: ${file}`, 'warn');
              continue;
            }
            
            const contentHash = this.calculateFileHash(content);
            const fileModTime = stats.mtime;
            
            // Check if we need to process this file
            if (deltaOnly && existingFiles[file]) {
              const existing = existingFiles[file];
              if (existing.contentHash === contentHash && 
                  existing.fileSize === content.length &&
                  new Date(existing.lastModified) >= fileModTime) {
                skipped++;
                continue; // File hasn't changed
              }
              
              // File changed - remove old chunks first
              await this.vectorStore.removeFileChunks(projectId, file);
              updated++;
            } else if (deltaOnly) {
              added++;
            }
            
            // Split large files into chunks
            const chunks = this.chunkContent(content, file);
            
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
            
            // Update progress based on files processed
            const currentProgress = startProgress + ((fileIndex / totalFiles) * (endProgress - startProgress));
            updateProgress(currentProgress, `Processed ${processed}/${totalFiles} files`);
            
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
      
      if (documents.length > 0) {
        updateProgress(90, 'Saving documents to database...');
        await this.vectorStore.addDocuments(documents);
        logMethod(`Successfully indexed ${documents.length} document chunks for project ${projectId}`, 'success');
      }
      
      // Save project metadata for future reference (use original host path)
      updateProgress(95, 'Saving project metadata...');
      await this.vectorStore.saveProjectMetadata(projectId, originalPath, excludePatterns);
      
      updateProgress(100, 'Indexing completed successfully');
      
      const result = {
        success: true,
        filesProcessed: processed,
        chunksIndexed: documents.length,
        projectId,
        filesTotal: totalFiles
      };
      
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

  calculateFileHash(content) {
    return crypto.createHash('md5').update(content).digest('hex');
  }

  isTextFile(filename) {
    const textExtensions = [
      '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.c', '.cpp', '.h', '.hpp',
      '.cs', '.php', '.rb', '.go', '.rs', '.swift', '.kt', '.scala', '.clj',
      '.html', '.css', '.scss', '.sass', '.less', '.xml', '.json', '.yaml', '.yml',
      '.md', '.txt', '.sql', '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat',
      '.dockerfile', '.gitignore', '.env.example', '.conf', '.config', '.ini',
      '.toml', '.lock', '.vue', '.svelte', '.astro', '.r', '.R', '.m', '.pl'
    ];
    
    const ext = path.extname(filename).toLowerCase();
    return textExtensions.includes(ext) || !path.extname(filename);
  }

  chunkContent(content, filename) {
    const maxChunkSize = 2000; // chars
    const lines = content.split('\n');
    const chunks = [];
    
    let currentChunk = '';
    let startLine = 1;
    let currentLine = 1;
    
    for (const line of lines) {
      if (currentChunk.length + line.length > maxChunkSize && currentChunk.length > 0) {
        chunks.push({
          content: `File: ${filename}\nLines ${startLine}-${currentLine - 1}:\n\n${currentChunk}`,
          startLine,
          endLine: currentLine - 1
        });
        currentChunk = '';
        startLine = currentLine;
      }
      
      currentChunk += line + '\n';
      currentLine++;
    }
    
    if (currentChunk.trim()) {
      chunks.push({
        content: `File: ${filename}\nLines ${startLine}-${currentLine - 1}:\n\n${currentChunk}`,
        startLine,
        endLine: currentLine - 1
      });
    }
    
    return chunks.length > 0 ? chunks : [{
      content: `File: ${filename}\n\n${content}`,
      startLine: 1,
      endLine: lines.length
    }];
  }
}