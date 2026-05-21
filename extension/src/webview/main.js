(function() {
    console.log('[Lattice Debug] main.js loading...');
    
    // Ensure `vscode` is available to the whole script without throwing
    let vscode = null;
    try {
        vscode = acquireVsCodeApi();
    } catch (e) {
        console.warn('[Lattice Debug] acquireVsCodeApi() failed:', e.message);
    }
    
    try {
        const chatHistory = document.getElementById('chat-history');
        const promptInput = document.getElementById('prompt-input');
        const sendButton = document.getElementById('send-button');
        const attachButton = document.getElementById('attach-button');
        
        // Modal & Settings elements
        const settingsModal = document.getElementById('settings-modal');
        const settingsButton = document.getElementById('settings-button');
        const modalCloseBtn = document.querySelector('.modal-close-btn');
        
        // Defensive checks
        console.log('[Lattice Debug] Elements found:', {
            settingsButton: !!settingsButton,
            attachButton: !!attachButton,
            settingsModal: !!settingsModal,
            modalCloseBtn: !!modalCloseBtn,
            chatHistory: !!chatHistory,
            sendButton: !!sendButton
        });
        
        if (!settingsButton) {
            console.error('[Lattice Debug] settings-button NOT found! Available buttons:', document.querySelectorAll('button'));
        }
        if (!attachButton) {
            console.warn('[Lattice Debug] attach-button NOT found!');
        }
        if (!settingsModal) {
            console.error('[Lattice Debug] settings-modal NOT found!');
        }
        
        const settingsSaveBtn = document.getElementById('settings-save-btn');
        const settingsCancelBtn = document.getElementById('settings-cancel-btn');
        const geminiApiInput = document.getElementById('gemini-api-input');
        const groqApiInput = document.getElementById('groq-api-input');
        const ollamaUrlInput = document.getElementById('ollama-url-input');
        const fetchOllamaModelsBtn = document.getElementById('fetch-ollama-models-btn');
        const fetchGeminiModelsBtn = document.getElementById('fetch-gemini-models-btn');
        const fetchGroqModelsBtn = document.getElementById('fetch-groq-models-btn');
        const ollamaModelsList = document.getElementById('ollama-models-list');
        const l1ModelSelect = document.getElementById('l1-model-select');
        const l2ModelSelect = document.getElementById('l2-model-select');

    let currentBotContainer = null;
    let currentStepsDetails = null;
    let isGenerating = false;
    
    // Known models for each provider
    const KNOWN_MODELS = {
        gemini: ['gemini-3.1-pro', 'gemini-3.1-flash', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-1.0-pro', 'gemini-pro'],
        groq: ['mixtral-8x7b-32768', 'llama-3.3-70b-versatile', 'llama-3.1-70b-versatile', 'llama-3-70b-8192', 'llama-2-70b-4096'],
        ollama: []
    };
    
    let availableModels = { 
        gemini: [...KNOWN_MODELS.gemini], 
        groq: [...KNOWN_MODELS.groq], 
        ollama: [] 
    };

    const SEND_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M8.354 1.146a.5.5 0 0 0-.708 0l-6 6a.5.5 0 0 0 .708.708L7.5 2.707V14.5a.5.5 0 0 0 1 0V2.707l5.146 5.147a.5.5 0 0 0 .708-.708l-6-6z"/></svg>`;
    const STOP_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="3" width="10" height="10" rx="1"/></svg>`;

    // Listen for messages from the extension context
    window.addEventListener('message', event => {
        const message = event.data;
        switch (message.type) {
            case 'initSettings':
                console.log('[Lattice Debug] Received initSettings:', message.settings);
                if (message.settings) {
                    if (message.settings.geminiApi !== undefined) geminiApiInput.value = message.settings.geminiApi;
                    if (message.settings.groqApi !== undefined) groqApiInput.value = message.settings.groqApi;
                    if (message.settings.ollamaUrl !== undefined) ollamaUrlInput.value = message.settings.ollamaUrl;
                    
                    if (message.settings.availableModels) {
                        availableModels = {
                            gemini: message.settings.availableModels.gemini?.length > 0 ? message.settings.availableModels.gemini : KNOWN_MODELS.gemini,
                            groq: message.settings.availableModels.groq?.length > 0 ? message.settings.availableModels.groq : KNOWN_MODELS.groq,
                            ollama: message.settings.availableModels.ollama || []
                        };
                    }
                    
                    updateModelSelectors();
                    
                    if (message.settings.l1Model) l1ModelSelect.value = message.settings.l1Model;
                    if (message.settings.l2Model) l2ModelSelect.value = message.settings.l2Model;
                    
                    // Keep the local state in sync
                    if (vscode) {
                        vscode.setState({
                            geminiApi: geminiApiInput.value,
                            groqApi: groqApiInput.value,
                            ollamaUrl: ollamaUrlInput.value,
                            l1Model: l1ModelSelect.value,
                            l2Model: l2ModelSelect.value,
                            availableModels
                        });
                    }
                }
                break;
            case 'askApproval':
                showDiffApproval(message.id, message.target, message.oldText, message.newText);
                chatHistory.scrollTop = chatHistory.scrollHeight;
                break;
            case 'request_plan_approval':
                showPlanApproval(message.id, message.plan);
                chatHistory.scrollTop = chatHistory.scrollHeight;
                break;
            case 'startBotMessage':
                currentBotContainer = document.createElement('div');
                currentBotContainer.className = 'message bot-message';
                
                currentStepsDetails = document.createElement('details');
                currentStepsDetails.className = 'agent-steps-container';
                currentStepsDetails.style.display = 'none';
                currentStepsDetails.innerHTML = '<summary>View Agent Steps</summary><div class="steps-content"></div>';
                
                const finalContent = document.createElement('div');
                finalContent.className = 'final-content';
                
                currentBotContainer.appendChild(currentStepsDetails);
                currentBotContainer.appendChild(finalContent);
                
                chatHistory.appendChild(currentBotContainer);
                chatHistory.scrollTop = chatHistory.scrollHeight;
                break;
            case 'addStep':
                if (!currentStepsDetails) return;
                currentStepsDetails.style.display = 'block';
                const stepDiv = document.createElement('div');
                stepDiv.className = 'agent-step';
                stepDiv.innerHTML = `<span>${message.icon}</span> <span>${message.action}:</span> <code>${message.target}</code>`;
                currentStepsDetails.querySelector('.steps-content').appendChild(stepDiv);
                chatHistory.scrollTop = chatHistory.scrollHeight;
                break;
            case 'addMessage':
                if (message.isUser) {
                    appendMessage(message.text, true, false, message.isError);
                } else {
                    if (currentBotContainer) {
                        const content = currentBotContainer.querySelector('.final-content');
                        if (message.isError) {
                            content.style.color = 'var(--vscode-errorForeground)';
                            content.textContent = message.text;
                        } else {
                            content.innerHTML = marked.parse(message.text);
                        }
                        currentBotContainer = null;
                        currentStepsDetails = null;
                        chatHistory.scrollTop = chatHistory.scrollHeight;
                    } else {
                        appendMessage(message.text, false, false, message.isError);
                    }
                }
                break;
            case 'setLoading':
                let existingLoading = document.getElementById('loading-indicator');
                if (existingLoading) {
                    existingLoading.textContent = message.text;
                } else {
                    existingLoading = document.createElement('div');
                    existingLoading.id = 'loading-indicator';
                    existingLoading.className = 'message loading bot-message'; // Match styling but italicized
                    existingLoading.textContent = message.text;
                    chatHistory.appendChild(existingLoading);
                }
                chatHistory.scrollTop = chatHistory.scrollHeight;
                break;
            case 'statusUpdate': {
                // Update subtext on the active loading indicator if present
                const loader = document.getElementById('loading-indicator');
                if (loader) {
                    let sub = loader.querySelector('.status-subtext');
                    if (!sub) {
                        sub = document.createElement('div');
                        sub.className = 'status-subtext';
                        sub.style.fontStyle = 'italic';
                        sub.style.fontSize = '0.9em';
                        sub.style.marginTop = '6px';
                        loader.appendChild(sub);
                    }
                    sub.textContent = message.value;
                }
                break;
            }
            case 'removeLoading': {
                const loader = document.getElementById('loading-indicator');
                if (loader) loader.remove();
                break;
            }
            case 'generationFinished':
                setGeneratingState(false);
                break;
            case 'debugUpdate':
                renderDebugPanel(message.chat_history, message.tool_history);
                break;
        }
    });

    function renderDebugPanel(chatHistoryData, toolHistoryData) {
        let panel = document.getElementById('debug-panel');
        if (!panel) {
            panel = document.createElement('details');
            panel.id = 'debug-panel';
            panel.className = 'debug-panel';
            const summary = document.createElement('summary');
            summary.textContent = 'Debug: Executor State (click to expand)';
            panel.appendChild(summary);

            const container = document.createElement('div');
            container.className = 'debug-contents';
            panel.appendChild(container);
            document.body.appendChild(panel);
        }

        const container = panel.querySelector('.debug-contents');
        container.innerHTML = '';

        const chatPre = document.createElement('pre');
        chatPre.className = 'debug-chat';
        chatPre.textContent = 'Chat History:\n' + JSON.stringify(chatHistoryData, null, 2);

        const toolPre = document.createElement('pre');
        toolPre.className = 'debug-tools';
        toolPre.textContent = 'Tool History:\n' + JSON.stringify(toolHistoryData, null, 2);

        container.appendChild(chatPre);
        container.appendChild(toolPre);
        panel.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }

    function appendMessage(text, isUser = false, isLoading = false, isError = false) {
        const msgDiv = document.createElement('div');
        msgDiv.className = 'message ' + (isUser ? 'user-message' : 'bot-message');
        if (isError) {
            msgDiv.style.color = 'var(--vscode-errorForeground)';
        }
        
        if (isLoading) {
            msgDiv.classList.add('loading');
            msgDiv.id = 'loading-indicator'; 
            msgDiv.textContent = text;
        } else if (!isUser) {
            msgDiv.innerHTML = marked.parse(text);
        } else {
            msgDiv.textContent = text;
        }
        
        chatHistory.appendChild(msgDiv);
        chatHistory.scrollTop = chatHistory.scrollHeight;
    }

    function showDiffApproval(id, target, oldText, newText) {
        const block = document.createElement('div');
        block.className = 'diff-approval-block';
        block.dataset.id = id;

        // Header showing which file is being changed
        const label = document.createElement('div');
        label.className = 'diff-file-label';
        label.innerHTML = `<span>✏️</span> <code>${target}</code>`;
        block.appendChild(label);

        // Diff body: show removed lines (old) then added lines (new)
        const body = document.createElement('div');
        body.className = 'diff-body';

        const renderLines = (text, cssClass, marker) => {
            text.split('\n').forEach(line => {
                const lineEl = document.createElement('div');
                lineEl.className = `diff-line ${cssClass}`;
                lineEl.innerHTML = `<span class="diff-line-marker">${marker}</span><span>${escapeHtml(line)}</span>`;
                body.appendChild(lineEl);
            });
        };

        renderLines(oldText, 'diff-line-removed', '-');
        renderLines(newText, 'diff-line-added', '+');
        block.appendChild(body);

        // Action buttons row
        const actions = document.createElement('div');
        actions.className = 'diff-actions';

        const acceptBtn = document.createElement('button');
        acceptBtn.className = 'diff-btn diff-btn-accept';
        acceptBtn.textContent = 'Accept';

        const rejectBtn = document.createElement('button');
        rejectBtn.className = 'diff-btn diff-btn-reject';
        rejectBtn.textContent = 'Reject';

        const resolveBlock = (accepted) => {
            acceptBtn.disabled = true;
            rejectBtn.disabled = true;
            // Replace action row with resolved label
            actions.innerHTML = '';
            const resolved = document.createElement('div');
            resolved.className = 'diff-resolved-label';
            resolved.textContent = accepted ? '✅ Edit accepted' : '❌ Edit rejected';
            block.appendChild(resolved);

            if (vscode) {
                vscode.postMessage({ type: accepted ? 'approveEdit' : 'rejectEdit', id });
            } else {
                console.warn('[Lattice Debug] Cannot post approve/reject - vscode API missing');
            }
        };

        acceptBtn.addEventListener('click', () => resolveBlock(true));
        rejectBtn.addEventListener('click', () => resolveBlock(false));

        actions.appendChild(acceptBtn);
        actions.appendChild(rejectBtn);
        block.appendChild(actions);

        chatHistory.appendChild(block);
    }

    function showPlanApproval(id, plan) {
        const block = document.createElement('div');
        block.className = 'plan-approval-block';
        block.dataset.id = id;

        const label = document.createElement('div');
        label.className = 'plan-approval-label';
        label.textContent = 'Lane 3 plan approval required';
        block.appendChild(label);

        const body = document.createElement('div');
        body.className = 'plan-approval-body';
        body.innerHTML = marked.parse(plan || 'No plan was generated.');
        block.appendChild(body);

        const actions = document.createElement('div');
        actions.className = 'plan-approval-actions';

        const approveBtn = document.createElement('button');
        approveBtn.className = 'plan-btn plan-btn-approve';
        approveBtn.textContent = 'Approve Plan';

        const rejectBtn = document.createElement('button');
        rejectBtn.className = 'plan-btn plan-btn-reject';
        rejectBtn.textContent = 'Reject & Modify';

        const resolveBlock = (approved) => {
            approveBtn.disabled = true;
            rejectBtn.disabled = true;
            actions.innerHTML = '';
            const resolved = document.createElement('div');
            resolved.className = 'plan-resolved-label';
            resolved.textContent = approved ? 'Plan approved. Execution will begin.' : 'Plan rejected. Send revised instructions to modify it.';
            block.appendChild(resolved);

            if (vscode) {
                vscode.postMessage({ type: approved ? 'approvePlan' : 'rejectPlan', id });
            } else {
                console.warn('[Lattice Debug] Cannot post plan approval - vscode API missing');
            }
        };

        approveBtn.addEventListener('click', () => resolveBlock(true));
        rejectBtn.addEventListener('click', () => resolveBlock(false));

        actions.appendChild(approveBtn);
        actions.appendChild(rejectBtn);
        block.appendChild(actions);

        chatHistory.appendChild(block);
    }

    function escapeHtml(text) {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function setGeneratingState(generating) {
        isGenerating = generating;
        if (generating) {
            sendButton.innerHTML = STOP_ICON;
            sendButton.title = "Stop generating";
            sendButton.classList.add('stop-button');
        } else {
            sendButton.innerHTML = SEND_ICON;
            sendButton.title = "Send message";
            sendButton.classList.remove('stop-button');
        }
    }

    function handleSendOrStop() {
        if (isGenerating) {
            if (vscode) {
                vscode.postMessage({ type: 'abortGeneration' });
            } else {
                console.warn('[Lattice Debug] abortGeneration requested but vscode API missing');
            }
            setGeneratingState(false);
        } else {
            sendPrompt();
        }
    }

    function sendPrompt() {
        const text = promptInput.value.trim();
        if (!text || isGenerating) return;

        setGeneratingState(true);
        promptInput.value = '';
        promptInput.style.height = 'auto';
        
        // Send the message to the extension
        if (vscode) {
            vscode.postMessage({ type: 'prompt', text: text });
        } else {
            console.warn('[Lattice Debug] prompt requested but vscode API missing');
            // Fallback: show message locally
            appendMessage(text, true, false, false);
        }
    }

    // Listener attachment flags for debug panel
    let listeners = {
        settings: false,
        attach: false,
        send: false
    };

    // Send button listener
    if (sendButton) {
        console.log('[Lattice Debug] Attaching click listener to send button');
        sendButton.addEventListener('click', handleSendOrStop);
        listeners.send = true;
    } else {
        console.error('[Lattice Debug] sendButton not found!');
    }
    
    // Send on Enter (Shift+Enter for newline)
    if (promptInput) {
        promptInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (!isGenerating) sendPrompt();
            }
        });
        
        // Auto resize text area
        promptInput.addEventListener('input', function() {
            this.style.height = 'auto';
            this.style.height = (this.scrollHeight) + 'px';
        });

        promptInput.focus();
    }

    // --- Initialization & State Persistence ---
    console.log('[Lattice Debug] Starting initialization...');
    
    // Visible debug indicator
    const debugIndicator = document.createElement('div');
    debugIndicator.style.fontSize = '10px';
    debugIndicator.style.color = 'var(--vscode-descriptionForeground)';
    debugIndicator.style.padding = '4px 8px';
    debugIndicator.style.opacity = '0.5';
    debugIndicator.textContent = 'Lattice JS Active';
    chatHistory.appendChild(debugIndicator);

    try {
        if (!vscode) {
            console.error('[Lattice Debug] vscode API is NOT available!');
            debugIndicator.textContent = 'Lattice JS Warning: vscode API missing';
            debugIndicator.style.color = 'orange';
        } else {
            // Load persisted settings from extension
            const saved = vscode.getState() || {};
            console.log('[Lattice Debug] Saved state:', saved);
            
            if (saved.geminiApi) geminiApiInput.value = saved.geminiApi;
            if (saved.groqApi) groqApiInput.value = saved.groqApi;
            if (saved.ollamaUrl) ollamaUrlInput.value = saved.ollamaUrl;
            
            // Merge saved models with defaults (preserving defaults if not saved)
            if (saved.availableModels) {
                availableModels = {
                    gemini: saved.availableModels.gemini?.length > 0 ? saved.availableModels.gemini : KNOWN_MODELS.gemini,
                    groq: saved.availableModels.groq?.length > 0 ? saved.availableModels.groq : KNOWN_MODELS.groq,
                    ollama: saved.availableModels.ollama || []
                };
            }

            // Initialize model selectors first so they have options
            updateModelSelectors();

            // Now set the selected values
            if (saved.l1Model) l1ModelSelect.value = saved.l1Model;
            if (saved.l2Model) l2ModelSelect.value = saved.l2Model;
        }
    } catch (e) {
        console.error('[Lattice Debug] Failed during initialization:', e);
        debugIndicator.textContent = 'Lattice JS Error: ' + e.message;
    }

    // --- Helper functions for settings ---
    // Update L1/L2 selectors with available models from all providers
    function updateModelSelectors() {
        if (!l1ModelSelect || !l2ModelSelect) return;

        const allModels = [
            ...(availableModels.gemini || []).map(m => ({ value: `gemini:${m}`, label: `Gemini: ${m}` })),
            ...(availableModels.groq || []).map(m => ({ value: `groq:${m}`, label: `Groq: ${m}` })),
            ...(availableModels.ollama || []).map(m => ({ value: `ollama:${m}`, label: `Ollama: ${m}` }))
        ];
        
        [l1ModelSelect, l2ModelSelect].forEach(select => {
            const currentVal = select.value;
            select.innerHTML = '<option value="" disabled selected>Select a model...</option>';
            allModels.forEach(m => {
                const opt = document.createElement('option');
                opt.value = m.value;
                opt.textContent = m.label;
                select.appendChild(opt);
            });
            if (currentVal) select.value = currentVal;
        });
    }

    // Fetch Ollama models from the URL
    async function fetchOllamaModels() {
        const url = ollamaUrlInput.value.trim();
        if (!url) {
            console.error('Please enter Ollama URL first');
            return;
        }
        try {
            const res = await fetch(`${url}/api/tags`);
            const data = await res.json();
            const models = data.models?.map(m => m.name) || [];
            availableModels.ollama = models;
            
            // Update Ollama models list in the modal
            ollamaModelsList.innerHTML = '';
            if (models.length === 0) {
                ollamaModelsList.innerHTML = '<option disabled>No models found</option>';
            } else {
                models.forEach(m => {
                    const opt = document.createElement('option');
                    opt.textContent = m;
                    ollamaModelsList.appendChild(opt);
                });
            }
            
            updateModelSelectors();
            saveSettings();
        } catch (e) {
            console.error(`Failed to fetch Ollama models: ${e.message}`);
        }
    }

    // Fetch Gemini models using Google's API
    async function fetchGeminiModels() {
        const apiKey = geminiApiInput.value.trim();
        if (!apiKey) {
            console.error('Please enter Gemini API key first');
            return;
        }
        try {
            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
            const data = await res.json();
            const models = data.models?.map(m => m.name.replace('models/', '')) || [];
            availableModels.gemini = models.length > 0 ? models : KNOWN_MODELS.gemini;
            
            updateModelSelectors();
            saveSettings();
            console.log('Gemini models fetched:', models.length > 0 ? models : 'Using defaults');
        } catch (e) {
            console.error(`Failed to fetch Gemini models: ${e.message}`);
            alert('Failed to fetch Gemini models. Check your API key and internet connection.');
        }
    }

    // Fetch Groq models using Groq's API
    async function fetchGroqModels() {
        const apiKey = groqApiInput.value.trim();
        if (!apiKey) {
            console.error('Please enter Groq API key first');
            return;
        }
        try {
            const res = await fetch('https://api.groq.com/openai/v1/models', {
                headers: {
                    'Authorization': `Bearer ${apiKey}`
                }
            });
            const data = await res.json();
            const models = data.data?.map(m => m.id) || [];
            availableModels.groq = models.length > 0 ? models : KNOWN_MODELS.groq;
            
            updateModelSelectors();
            saveSettings();
            console.log('Groq models fetched:', models.length > 0 ? models : 'Using defaults');
        } catch (e) {
            console.error(`Failed to fetch Groq models: ${e.message}`);
            alert('Failed to fetch Groq models. Check your API key and internet connection.');
        }
    }

    // Save settings and notify extension
    function saveSettings() {
        const settings = {
            geminiApi: geminiApiInput.value,
            groqApi: groqApiInput.value,
            ollamaUrl: ollamaUrlInput.value,
            l1Model: l1ModelSelect.value,
            l2Model: l2ModelSelect.value,
            availableModels
        };
        if (vscode) {
            vscode.setState(settings);
            vscode.postMessage({ type: 'updateSettings', settings });
        } else {
            console.warn('[Lattice Debug] saveSettings called but vscode API missing - skipping persist');
        }
    }

    // Modal handlers
    function openModal() {
        console.log('[Lattice Debug] openModal called');
        if (!settingsModal) {
            console.error('[Lattice Debug] settingsModal is null!');
            return;
        }
        settingsModal.classList.remove('hidden');
        console.log('[Lattice Debug] Modal opened');
    }

    function closeModal() {
        console.log('[Lattice Debug] closeModal called');
        if (!settingsModal) {
            console.error('[Lattice Debug] settingsModal is null!');
            return;
        }
        settingsModal.classList.add('hidden');
        console.log('[Lattice Debug] Modal closed');
    }

    // Attach event listeners with error checking

    if (settingsButton) {
        console.log('[Lattice Debug] Attaching click listener to settings button');
        settingsButton.addEventListener('click', openModal);
        listeners.settings = true;
    } else {
        console.error('[Lattice Debug] Cannot attach listener to settingsButton - element is null!');
    }

    // Attach event listener to + (attach) button - placeholder behavior for now
    if (attachButton) {
        console.log('[Lattice Debug] Attaching click listener to attach button');
        attachButton.addEventListener('click', () => {
            console.log('[Lattice Debug] ATTACH BUTTON CLICKED');
            alert('Attach feature coming soon...');
        });
        listeners.attach = true;
    } else {
        console.error('[Lattice Debug] Cannot attach listener to attachButton - element is null!');
    }

    
    if (modalCloseBtn) {
        modalCloseBtn.addEventListener('click', closeModal);
    } else {
        console.error('[Lattice Debug] Cannot attach listener to modalCloseBtn - element is null!');
    }
    
    if (settingsCancelBtn) {
        settingsCancelBtn.addEventListener('click', closeModal);
    }
    
    if (settingsSaveBtn) {
        settingsSaveBtn.addEventListener('click', () => {
            saveSettings();
            closeModal();
        });
    }
    
    if (fetchOllamaModelsBtn) {
        fetchOllamaModelsBtn.addEventListener('click', fetchOllamaModels);
    }
    
    if (fetchGeminiModelsBtn) {
        fetchGeminiModelsBtn.addEventListener('click', fetchGeminiModels);
    }
    
    if (fetchGroqModelsBtn) {
        fetchGroqModelsBtn.addEventListener('click', fetchGroqModels);
    }
    
    // Close modal on overlay click
    const modalOverlay = document.querySelector('.modal-overlay');
    if (modalOverlay) {
        modalOverlay.addEventListener('click', closeModal);
    }
    promptInput.focus();
    console.log('[Lattice Debug] main.js initialization complete');
    if (vscode) {
        vscode.postMessage({ type: 'ready' });
    }
    } catch (error) {
        console.error('[Lattice Debug] Fatal error in main.js:', error);
        const errorDiv = document.createElement('div');
        errorDiv.style.color = 'red';
        errorDiv.style.padding = '10px';
        errorDiv.textContent = 'ERROR: ' + error.message;
        document.body.appendChild(errorDiv);
    }
})();
