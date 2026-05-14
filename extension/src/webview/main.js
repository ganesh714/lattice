(function() {
    const vscode = acquireVsCodeApi();
    const chatHistory = document.getElementById('chat-history');
    const promptInput = document.getElementById('prompt-input');
    const sendButton = document.getElementById('send-button');
    
    // Modal & Settings elements
    const settingsModal = document.getElementById('settings-modal');
    const settingsButton = document.querySelector('.settings-button');
    const modalCloseBtn = document.querySelector('.modal-close-btn');
    const settingsSaveBtn = document.getElementById('settings-save-btn');
    const settingsCancelBtn = document.getElementById('settings-cancel-btn');
    const geminiApiInput = document.getElementById('gemini-api-input');
    const groqApiInput = document.getElementById('groq-api-input');
    const ollamaUrlInput = document.getElementById('ollama-url-input');
    const fetchOllamaModelsBtn = document.getElementById('fetch-ollama-models-btn');
    const ollamaModelsList = document.getElementById('ollama-models-list');
    const l1ModelSelect = document.getElementById('l1-model-select');
    const l2ModelSelect = document.getElementById('l2-model-select');

    let currentBotContainer = null;
    let currentStepsDetails = null;
    let isGenerating = false;
    let availableModels = { gemini: [], groq: [], ollama: [] };

    const SEND_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M8.354 1.146a.5.5 0 0 0-.708 0l-6 6a.5.5 0 0 0 .708.708L7.5 2.707V14.5a.5.5 0 0 0 1 0V2.707l5.146 5.147a.5.5 0 0 0 .708-.708l-6-6z"/></svg>`;
    const STOP_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="3" width="10" height="10" rx="1"/></svg>`;

    // Listen for messages from the extension context
    window.addEventListener('message', event => {
        const message = event.data;
        switch (message.type) {
            case 'askApproval':
                showDiffApproval(message.id, message.target, message.oldText, message.newText);
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
            case 'statusUpdate':
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
            case 'removeLoading':
                const loader = document.getElementById('loading-indicator');
                if (loader) loader.remove();
                break;
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

            vscode.postMessage({ type: accepted ? 'approveEdit' : 'rejectEdit', id });
        };

        acceptBtn.addEventListener('click', () => resolveBlock(true));
        rejectBtn.addEventListener('click', () => resolveBlock(false));

        actions.appendChild(acceptBtn);
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
            vscode.postMessage({ type: 'abortGeneration' });
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
        vscode.postMessage({
            type: 'prompt',
            text: text
        });
    }

    sendButton.addEventListener('click', handleSendOrStop);
    // Send on Enter (Shift+Enter for newline)
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

    // Load persisted settings from extension
    const saved = vscode.getState() || {};
    if (saved.geminiApi) geminiApiInput.value = saved.geminiApi;
    if (saved.groqApi) groqApiInput.value = saved.groqApi;
    if (saved.ollamaUrl) ollamaUrlInput.value = saved.ollamaUrl;
    if (saved.l1Model) l1ModelSelect.value = saved.l1Model;
    if (saved.l2Model) l2ModelSelect.value = saved.l2Model;
    if (saved.availableModels) availableModels = saved.availableModels;

    // Update L1/L2 selectors with available models from all providers
    function updateModelSelectors() {
        const allModels = [
            ...availableModels.gemini.map(m => ({ value: `gemini:${m}`, label: `Gemini: ${m}` })),
            ...availableModels.groq.map(m => ({ value: `groq:${m}`, label: `Groq: ${m}` })),
            ...availableModels.ollama.map(m => ({ value: `ollama:${m}`, label: `Ollama: ${m}` }))
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
            alert('Please enter Ollama URL first');
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
            alert(`Failed to fetch Ollama models: ${e.message}`);
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
        vscode.setState(settings);
        vscode.postMessage({ type: 'updateSettings', settings });
    }

    // Modal handlers
    function openModal() {
        settingsModal.classList.remove('hidden');
    }

    function closeModal() {
        settingsModal.classList.add('hidden');
    }

    settingsButton.addEventListener('click', openModal);
    modalCloseBtn.addEventListener('click', closeModal);
    settingsCancelBtn.addEventListener('click', closeModal);
    settingsSaveBtn.addEventListener('click', () => {
        saveSettings();
        closeModal();
    });
    
    fetchOllamaModelsBtn.addEventListener('click', fetchOllamaModels);
    
    // Close modal on overlay click
    document.querySelector('.modal-overlay').addEventListener('click', closeModal);

    // Initialize model selectors
    updateModelSelectors();
})();
