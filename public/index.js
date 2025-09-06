// ==========================================
// Global Variables and Constants
// ==========================================

/** @type {string[]} Array of log messages for UI display */
let logs = [];

/** @type {number|null} Timeout ID for auto-hiding status messages */
let statusTimeout = null;

// Theme Management Constants and Variables
/** @constant {string} LocalStorage key for storing user's theme preference */
const THEME_KEY = 'vector-mcp-theme';

/** @type {string} Current active theme ('system'|'light'|'dark') */
let currentTheme = 'system';

// Job Monitoring
/** @type {Set<string>} Set of currently monitored job IDs to prevent duplicates */
const activeJobs = new Set();

// Real-time Log Streaming
/** @type {EventSource|null} Server-Sent Events connection for log streaming */
let logStream = null;

/** @type {boolean} Flag indicating if log stream is currently active */
let logStreamActive = false;

/** @type {Element} Reference to log status display element */
const statusEl = document.getElementById('log-status');

// ==========================================
// Theme Management Functions
// ==========================================

/**
 * Detects the user's system color scheme preference
 * @returns {'light'|'dark'} The system's current color scheme
 */
function getSystemTheme() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Applies the specified theme to the document and updates the theme toggle icon
 * @param {'system'|'light'|'dark'} theme - The theme to apply
 */
function applyTheme(theme) {
    const root = document.documentElement;
    const themeIcon = document.getElementById('theme-icon');
    
    if (theme === 'system') {
        // Use system preference when in system mode
        const systemTheme = getSystemTheme();
        root.setAttribute('data-theme', systemTheme);
        themeIcon.textContent = '🌓'; // Half-moon icon for system theme
    } else {
        // Apply explicit light or dark theme
        root.setAttribute('data-theme', theme);
        themeIcon.textContent = theme === 'dark' ? '☀️' : '🌙';
    }
}

/**
 * Cycles through available themes (system → light → dark → system)
 * Saves the selection to localStorage and shows a notification
 */
function toggleTheme() {
    const themes = ['system', 'light', 'dark'];
    const currentIndex = themes.indexOf(currentTheme);
    const nextIndex = (currentIndex + 1) % themes.length;
    currentTheme = themes[nextIndex];
    
    // Persist user's theme preference
    localStorage.setItem(THEME_KEY, currentTheme);
    applyTheme(currentTheme);
    
    // Show brief notification to user
    const themeNames = { system: 'System', light: 'Light', dark: 'Dark' };
    showStatus(`Theme: ${themeNames[currentTheme]}`, 'info');
}

/**
 * Initializes the theme system on page load
 * Loads saved preference from localStorage and sets up system theme change listeners
 */
function initTheme() {
    // Load saved theme preference or default to system
    currentTheme = localStorage.getItem(THEME_KEY) || 'system';
    applyTheme(currentTheme);
    
    // Listen for OS-level theme changes when in system mode
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (currentTheme === 'system') {
            applyTheme('system');
        }
    });
}

// ==========================================
// Logging Functions
// ==========================================

/**
 * Adds a timestamped log message to the UI display
 * @param {string} message - The message to log
 * @param {'info'|'success'|'error'|'warn'} [type='info'] - The log level (currently unused)
 */
function log(message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    logs.push(`[${timestamp}] ${message}`);
    updateLogDisplay();
}

/**
 * Updates the log display container with current log messages
 * Automatically scrolls to bottom to show latest entries
 */
function updateLogDisplay() {
    const logContainer = document.getElementById('logs');
    logContainer.textContent = logs.join('\n');
    logContainer.scrollTop = logContainer.scrollHeight;
}

/**
 * Clears both the UI log display and the server log file
 * Makes API call to clear server-side logs and updates streaming status
 * @returns {Promise<void>}
 */
async function clearLogs() {
    try {
        updateLogStatus('🧹 Clearing logs...', '#f39c12');
        
        const response = await fetch('/api/logs/clear', { method: 'POST' });
        const result = await response.json();
        
        if (response.ok) {
            // Clear local display immediately
            logs = [];
            updateLogDisplay();
            showStatus('Server logs cleared - stream continues monitoring', 'success');
            updateLogStatus('🔴 Live streaming (cleared)', '#27ae60');
        } else {
            showStatus(`Error clearing server logs: ${result.error}`, 'error');
            updateLogStatus('❌ Error clearing logs', '#e74c3c');
        }
    } catch (error) {
        showStatus('Network error clearing logs', 'error');
        updateLogStatus('❌ Network error', '#e74c3c');
    }
}

/**
 * Updates the log streaming status indicator
 * @param {string} message - Status message to display
 * @param {string} [color='#666'] - CSS color for the status text
 */
function updateLogStatus(message, color = '#666') {
    if (statusEl) {
        statusEl.textContent = message;
        statusEl.style.color = color;
    }
}

// ==========================================
// UI Status and Notification Functions
// ==========================================

/**
 * Displays a temporary status message to the user
 * Automatically hides after 10 seconds
 * @param {string} message - The status message to display
 * @param {'info'|'success'|'error'} [type='info'] - The status type for styling
 */
function showStatus(message, type = 'info') {
    const statusDiv = document.getElementById('status-message');
    clearTimeout(statusTimeout);
    statusDiv.className = `status ${type}`;
    statusDiv.textContent = message;
    
    // Auto-hide after 10 seconds
    statusTimeout = setTimeout(() => {
        statusDiv.className = '';
        statusDiv.textContent = '';
    }, 10000);
}

// ==========================================
// Project Management Functions
// ==========================================

/**
 * Creates a new project index by sending form data to the server
 * Validates input, starts indexing job, and monitors progress
 * @returns {Promise<void>}
 */
async function createIndex() {
    // Get and validate form inputs
    const projectId = document.getElementById('project-id').value.trim();
    const directoryPath = document.getElementById('directory-path').value.trim();
    const excludePatterns = document.getElementById('exclude-patterns').value
        .split('\n')
        .map(p => p.trim())
        .filter(p => p);

    if (!projectId || !directoryPath) {
        showStatus('Please provide both Project ID and Directory Path', 'error');
        return;
    }

    // Update button state to show progress
    const btn = document.getElementById('create-btn');
    btn.disabled = true;
    btn.textContent = 'Starting...';

    try {
        log(`Starting index creation for project: ${projectId}`);
        log(`Directory: ${directoryPath}`);
        
        // Send create request to API
        const response = await fetch('/api/projects', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                projectId,
                directoryPath,
                excludePatterns
            })
        });

        const result = await response.json();
        
        if (response.ok && result.jobId) {
            showStatus('Indexing job started! Check logs for progress...', 'info');
            btn.textContent = 'Indexing...';
            
            // Monitor the async job until completion
            monitorJob(result.jobId, () => {
                btn.disabled = false;
                btn.textContent = 'Create Index';
                loadProjects(); // Refresh project list
            });
        } else {
            log(`❌ Error: ${result.error || 'Unknown error'}`);
            showStatus(result.error || 'Unknown error', 'error');
            btn.disabled = false;
            btn.textContent = 'Create Index';
        }
    } catch (error) {
        log(`❌ Network error: ${error.message}`);
        showStatus('Network error occurred', 'error');
        btn.disabled = false;
        btn.textContent = 'Create Index';
    }
}

/**
 * Creates a test index using the current server directory
 * Useful for quick testing without specifying paths
 * @returns {Promise<void>}
 */
async function testCurrentDir() {
    const btn = document.getElementById('test-btn');
    btn.disabled = true;
    btn.textContent = 'Starting...';

    try {
        const response = await fetch('/api/test-current-dir', {
            method: 'POST'
        });

        const result = await response.json();
        
        if (response.ok && result.jobId) {
            showStatus('Test indexing job started! Check logs for progress...', 'info');
            btn.textContent = 'Testing...';
            
            // Monitor the test job
            monitorJob(result.jobId, () => {
                btn.disabled = false;
                btn.textContent = 'Test with Current Directory';
                loadProjects();
            });
        } else {
            log(`❌ Test error: ${result.error || 'Unknown error'}`);
            showStatus(result.error || 'Unknown error', 'error');
            btn.disabled = false;
            btn.textContent = 'Test with Current Directory';
        }
    } catch (error) {
        log(`❌ Network error: ${error.message}`);
        showStatus('Network error occurred', 'error');
        btn.disabled = false;
        btn.textContent = 'Test with Current Directory';
    }
}

/**
 * Loads and displays all available projects from the server
 * Updates both the project list display and search dropdown
 * @returns {Promise<void>}
 */
async function loadProjects() {
    try {
        const response = await fetch('/api/projects');
        const projects = await response.json();
        
        const projectList = document.getElementById('project-list');
        const searchSelect = document.getElementById('search-project');
        
        // Reset search dropdown
        searchSelect.innerHTML = '<option value="">All projects</option>';
        
        if (projects.length === 0) {
            projectList.innerHTML = '<p>No projects found. Create your first index!</p>';
            return;
        }
        
        // Generate project cards with dynamic content
        projectList.innerHTML = projects.map(project => `
            <div class="project-card">
                <h3>${project.projectId}</h3>
                <div class="project-stats">
                    <div>Documents: ${project.documentCount}</div>
                    <div>Last Modified: ${new Date(project.lastModified).toLocaleString()}</div>
                    ${project.directoryPath ? `<div>Path: ${project.directoryPath}</div>` : ''}
                    ${project.excludePatterns && project.excludePatterns.length > 0 ? 
                      `<div>Excludes: ${project.excludePatterns.length} patterns</div>` : ''}
                </div>
                <button onclick="updateProject('${project.projectId}')" style="background: #f39c12;">Update</button>
                <button onclick="deleteProject('${project.projectId}')" class="danger">Delete</button>
                <button onclick="showProjectDetails('${project.projectId}')">Details</button>
            </div>
        `).join('');
        
        // Populate search dropdown with project options
        projects.forEach(project => {
            const option = document.createElement('option');
            option.value = project.projectId;
            option.textContent = project.projectId;
            searchSelect.appendChild(option);
        });
        
    } catch (error) {
        log(`❌ Error loading projects: ${error.message}`);
        showStatus('Error loading projects', 'error');
    }
}

/**
 * Opens the update modal for a specific project with pre-filled data
 * Fetches project metadata from server to populate form fields
 * @param {string} projectId - The ID of the project to update
 * @returns {Promise<void>}
 */
async function updateProject(projectId) {
    try {
        // Fetch existing project metadata for pre-filling form
        const metadataResponse = await fetch(`/api/projects/${projectId}/metadata`);
        let defaultPath = '';
        let defaultPatterns = '';
        
        if (metadataResponse.ok) {
            const metadata = await metadataResponse.json();
            defaultPath = metadata.directoryPath || '';
            defaultPatterns = metadata.excludePatterns ? metadata.excludePatterns.join('\n') : '';
        }
        
        // Pre-fill modal form fields
        document.getElementById('modal-project-id').value = projectId;
        document.getElementById('modal-directory-path').value = defaultPath;
        document.getElementById('modal-exclude-patterns').value = defaultPatterns;
        
        // Show the update modal
        document.getElementById('updateModal').style.display = 'block';
        
    } catch (error) {
        log(`❌ Error loading project metadata: ${error.message}`);
        showStatus('Error loading project data', 'error');
    }
}

/**
 * Confirms and executes the project update with delta indexing
 * Validates form data and starts an update job
 * @returns {Promise<void>}
 */
async function confirmUpdate() {
    // Get form data from modal
    const projectId = document.getElementById('modal-project-id').value;
    const directoryPath = document.getElementById('modal-directory-path').value.trim();
    const excludePatterns = document.getElementById('modal-exclude-patterns').value;
    const excludeList = excludePatterns ? excludePatterns.split('\n').map(p => p.trim()).filter(p => p) : [];

    if (!directoryPath) {
        showStatus('Please enter a directory path', 'error');
        return;
    }

    try {
        closeModal('updateModal');
        
        // Send delta update request
        const response = await fetch(`/api/projects/${projectId}/update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                directoryPath,
                excludePatterns: excludeList
            })
        });

        const result = await response.json();
        
        if (response.ok && result.jobId) {
            showStatus('Delta update job started! Check logs for progress...', 'info');
            
            // Monitor the update job
            monitorJob(result.jobId, () => {
                loadProjects(); // Refresh project list after completion
            });
        } else {
            log(`❌ Update error: ${result.error || 'Unknown error'}`);
            showStatus(result.error || 'Unknown error', 'error');
        }
    } catch (error) {
        log(`❌ Network error: ${error.message}`);
        showStatus('Network error occurred', 'error');
    }
}

/**
 * Deletes a project after user confirmation
 * Removes all associated documents and metadata from the server
 * @param {string} projectId - The ID of the project to delete
 * @returns {Promise<void>}
 */
async function deleteProject(projectId) {
    // Confirm destructive action with user
    if (!confirm(`Are you sure you want to delete project "${projectId}"? This cannot be undone.`)) {
        return;
    }

    try {
        log(`Deleting project: ${projectId}`);
        
        const response = await fetch(`/api/projects/${projectId}`, {
            method: 'DELETE'
        });

        const result = await response.json();
        
        if (response.ok) {
            log(`✅ Project deleted: ${result.deletedCount} documents removed`);
            showStatus('Project deleted successfully', 'success');
            loadProjects(); // Refresh the project list
        } else {
            log(`❌ Delete error: ${result.error}`);
            showStatus(result.error, 'error');
        }
    } catch (error) {
        log(`❌ Network error: ${error.message}`);
        showStatus('Network error occurred', 'error');
    }
}

/**
 * Fetches and displays detailed statistics for a project
 * Shows document count, file count, and file list in logs
 * @param {string} projectId - The ID of the project to get details for
 * @returns {Promise<void>}
 */
async function showProjectDetails(projectId) {
    try {
        const response = await fetch(`/api/projects/${projectId}/stats`);
        const stats = await response.json();
        
        // Display project details in log area
        log(`Project: ${stats.projectId}`);
        log(`Total Documents: ${stats.totalDocuments}`);
        log(`Total Files: ${stats.totalFiles}`);
        log(`Files: ${stats.files.join(', ')}`);
        
    } catch (error) {
        log(`❌ Error loading project details: ${error.message}`);
    }
}

// ==========================================
// Search Functions
// ==========================================

/**
 * Performs a semantic search across indexed projects
 * Displays results in formatted cards with similarity scores
 * @returns {Promise<void>}
 */
async function testSearch() {
    // Get search parameters from form
    const query = document.getElementById('search-query').value.trim();
    const projectId = document.getElementById('search-project').value;
    const limit = parseInt(document.getElementById('search-limit').value) || 5;

    if (!query) {
        showStatus('Please enter a search query', 'error');
        return;
    }

    // Update search button state
    const btn = document.getElementById('search-btn');
    btn.disabled = true;
    btn.textContent = 'Searching...';

    try {
        log(`Searching for: "${query}"`);
        if (projectId) log(`Project filter: ${projectId}`);
        
        // Send search request to MCP context endpoint
        const response = await fetch('/mcp/context', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                query,
                topK: limit,
                projectId: projectId || undefined
            })
        });

        const result = await response.json();
        
        if (response.ok) {
            log(`✅ Search completed! Found ${result.results.length} results`);
            
            // Generate formatted search results
            const resultsDiv = document.getElementById('search-results');
            resultsDiv.innerHTML = `
                <h3>Search Results (${result.results.length})</h3>
                ${result.results.map((item, index) => `
                    <div style="border: 1px solid #ddd; margin: 10px 0; padding: 10px; border-radius: 4px;">
                        <strong>#${index + 1} - ${item.filePath || 'Unknown file'}</strong> 
                        <span style="color: #666;">(Score: ${item.score.toFixed(4)})</span>
                        ${item.projectId ? `<br><small>Project: ${item.projectId}</small>` : ''}
                        <pre style="margin: 10px 0; background: #f5f5f5; padding: 10px; border-radius: 4px; white-space: pre-wrap; max-height: 200px; overflow-y: auto;">${item.content}</pre>
                    </div>
                `).join('')}
            `;
            
        } else {
            log(`❌ Search error: ${result.error}`);
            showStatus(result.error, 'error');
        }
    } catch (error) {
        log(`❌ Network error: ${error.message}`);
        showStatus('Network error occurred', 'error');
    } finally {
        // Always reset button state
        btn.disabled = false;
        btn.textContent = 'Search';
    }
}

// ==========================================
// Job Monitoring Functions
// ==========================================

/**
 * Monitors an asynchronous job until completion
 * Polls job status every 3 seconds and updates UI with progress
 * @param {string} jobId - The ID of the job to monitor
 * @param {Function} [onComplete] - Callback function to execute when job completes
 * @returns {Promise<void>}
 */
async function monitorJob(jobId, onComplete) {
    // Prevent duplicate monitoring of the same job
    if (activeJobs.has(jobId)) {
        return;
    }
    
    activeJobs.add(jobId);
    
    const pollInterval = 3000; // Poll every 3 seconds
    let attempts = 0;
    const maxAttempts = 600; // Max 30 minutes (600 * 3 seconds)
    
    /**
     * Internal polling function that checks job status
     * @returns {Promise<void>}
     */
    const poll = async () => {
        attempts++;
        
        try {
            const response = await fetch(`/api/jobs/${jobId}`);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            
            const job = await response.json();
            
            // Update UI with current job progress
            updateJobStatus(job);
            
            if (job.status === 'completed') {
                showStatus('Job completed successfully!', 'success');
                activeJobs.delete(jobId);
                if (onComplete) onComplete();
                return;
            }
            
            if (job.status === 'failed') {
                showStatus(`Job failed: ${job.error || 'Unknown error'}`, 'error');
                activeJobs.delete(jobId);
                if (onComplete) onComplete();
                return;
            }
            
            // Continue polling for running/pending jobs
            if (job.status === 'running' || job.status === 'pending') {
                if (attempts < maxAttempts) {
                    setTimeout(poll, pollInterval);
                } else {
                    showStatus('Job monitoring timeout - check logs for status', 'error');
                    activeJobs.delete(jobId);
                    if (onComplete) onComplete();
                }
            }
            
        } catch (error) {
            // Retry on network errors up to max attempts
            if (attempts < maxAttempts) {
                setTimeout(poll, pollInterval);
            } else {
                activeJobs.delete(jobId);
                if (onComplete) onComplete();
            }
        }
    };
    
    // Start polling after 1 second delay
    setTimeout(poll, 1000);
}

/**
 * Updates the UI status based on job progress information
 * Shows progress percentage and status in the status bar
 * @param {Object} job - Job object containing status and progress information
 * @param {string} job.id - Unique job identifier
 * @param {string} job.status - Current job status ('pending'|'running'|'completed'|'failed')
 * @param {number} [job.progress] - Job progress percentage (0-100)
 */
function updateJobStatus(job) {
    const progress = job.progress || 0;
    const status = job.status || 'unknown';
    
    // Note: Server logs will show detailed progress via streaming
    // This function only updates the status bar for active jobs
    
    if (status === 'running') {
        if (progress > 0) {
            showStatus(`Job ${job.id.substr(-8)}: ${progress.toFixed(1)}% complete`, 'info');
        } else {
            showStatus(`Job ${job.id.substr(-8)}: Running...`, 'info');
        }
    } else if (status === 'pending') {
        showStatus(`Job ${job.id.substr(-8)}: Pending...`, 'info');
    }
}

/**
 * Loads and displays recent jobs in the jobs list section
 * Shows jobs from the last 24 hours plus any currently running jobs
 * @returns {Promise<void>}
 */
async function loadJobs() {
    try {
        const response = await fetch('/api/jobs');
        const jobs = await response.json();
        
        const jobsList = document.getElementById('jobs-list');
        
        if (jobs.length === 0) {
            jobsList.innerHTML = '<p>No jobs found.</p>';
            return;
        }
        
        // Filter to show recent jobs (last 24 hours) and active jobs
        const recentJobs = jobs.filter(job => {
            const age = Date.now() - new Date(job.startTime).getTime();
            return age < 24 * 60 * 60 * 1000 || job.status === 'running' || job.status === 'pending';
        }).slice(0, 10); // Limit to 10 most recent jobs
        
        // Generate job cards with status indicators and progress bars
        jobsList.innerHTML = recentJobs.map(job => {
            const duration = job.endTime ? 
                Math.round((new Date(job.endTime) - new Date(job.startTime)) / 1000) + 's' : 
                Math.round((Date.now() - new Date(job.startTime)) / 1000) + 's';
            
            // Color-code job cards by status
            const statusColor = {
                'pending': '#f39c12',
                'running': '#3498db', 
                'completed': '#27ae60',
                'failed': '#e74c3c'
            }[job.status] || '#95a5a6';
            
            // Show progress bar for jobs with progress data
            const progressBar = (job.status === 'running' || job.status === 'completed' || job.status === 'failed') && job.progress > 0 ? `
                <div class="progress-bar">
                    <div class="progress-fill ${job.status}" style="width: ${job.progress}%"></div>
                </div>
            ` : '';

            return `
                <div class="project-card" style="border-left: 4px solid ${statusColor};">
                    <h4>${job.type.toUpperCase()} - ${job.projectId}</h4>
                    <div class="project-stats">
                        <div><strong>Status:</strong> ${job.status.charAt(0).toUpperCase() + job.status.slice(1)}</div>
                        ${job.status === 'running' && job.progress > 0 ? 
                          `<div><strong>Progress:</strong> ${job.progress.toFixed(1)}%</div>` : 
                          ''}
                        <div><strong>Duration:</strong> ${duration}</div>
                        <div><strong>Started:</strong> ${new Date(job.startTime).toLocaleString()}</div>
                        ${job.stats.filesProcessed ? `<div><strong>Files:</strong> ${job.stats.filesProcessed}${job.stats.filesTotal ? `/${job.stats.filesTotal}` : ''} processed, ${job.stats.chunksIndexed} chunks</div>` : ''}
                        ${job.error ? `<div style="color: #e74c3c;"><strong>Error:</strong> ${job.error}</div>` : ''}
                    </div>
                    ${progressBar}
                </div>
            `;
        }).join('');
        
    } catch (error) {
        log(`❌ Error loading jobs: ${error.message}`);
    }
}

// ==========================================
// Modal Management Functions
// ==========================================

/**
 * Closes a modal dialog by hiding it
 * @param {string} modalId - The ID of the modal element to close
 */
function closeModal(modalId) {
    document.getElementById(modalId).style.display = 'none';
}

// ==========================================
// Real-time Log Streaming Functions
// ==========================================

/**
 * Establishes a Server-Sent Events connection for real-time log streaming
 * Handles connection management, reconnection, and log message processing
 */
function startLogStream() {
    // Close existing connection if any
    if (logStream) {
        logStream.close();
    }
    
    // Establish new EventSource connection
    logStream = new EventSource('/api/logs/stream');
    logStreamActive = true;
    updateLogStatus('Connecting...', '#f39c12');
    
    /**
     * Handles incoming log messages from server
     * @param {MessageEvent} event - The message event from EventSource
     */
    logStream.onmessage = function(event) {
        try {
            const data = JSON.parse(event.data);
            
            if (data.type === 'connected') {
                updateLogStatus('🔴 Live streaming server.log', '#27ae60');
            } else if (data.type === 'historical') {
                // Display historical log entries
                log(data.message);
            } else if (data.type === 'live') {
                // Display real-time log entries
                log(data.message);
                // Update status if it was showing 'cleared'
                if (statusEl && statusEl.textContent.includes('cleared')) {
                    updateLogStatus('🔴 Live streaming server.log', '#27ae60');
                }
            } else if (data.type === 'cleared') {
                // Handle log file clearing event
                log(data.message);
                updateLogStatus('🔴 Live streaming (logs cleared)', '#f39c12');
            } else if (data.type === 'file_missing') {
                // Handle missing log file scenario
                log(data.message);
                updateLogStatus('⚠️ Waiting for log file...', '#e74c3c');
            }
        } catch (error) {
            console.error('Error parsing log stream data:', error);
        }
    };

    /**
     * Handles connection errors and implements auto-reconnection
     * @param {Event} event - The error event from EventSource
     */
    logStream.onerror = function(event) {
        updateLogStatus('❌ Connection error - reconnecting...', '#e74c3c');
        logStreamActive = false;
        
        // Auto-reconnect after 3 second delay
        setTimeout(() => {
            if (!logStreamActive) {
                startLogStream();
            }
        }, 3000);
    };

    /**
     * Handles successful connection establishment
     * @param {Event} event - The open event from EventSource
     */
    logStream.onopen = function(event) {
        updateLogStatus('📡 Connected to log stream', '#3498db');
    };
}

// ==========================================
// Event Listeners and Initialization
// ==========================================

/**
 * Global click handler for closing modals when clicking outside them
 * @param {MouseEvent} event - The click event
 */
window.onclick = function(event) {
    const modals = document.querySelectorAll('.modal');
    modals.forEach(modal => {
        if (event.target == modal) {
            modal.style.display = 'none';
        }
    });
}

/**
 * Main initialization function - runs when page loads
 * Sets up theme system, loads data, and starts real-time features
 */
window.addEventListener('load', () => {
    // Initialize theme system first
    initTheme();
    
    // Load initial data
    loadProjects();
    loadJobs();
    
    // Start real-time log streaming
    startLogStream();
    
    // Set up periodic job refresh every 10 seconds
    setInterval(loadJobs, 10000);
});

// ==========================================
// Initial Setup
// ==========================================

// Add initial log messages (will be replaced by server stream)
log('Vector MCP Index Manager initialized');
log('Connecting to server log stream...');