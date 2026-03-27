window.Nyan = window.Nyan || {};

window.Nyan.StateService = (function() {
    const _state = {
        books: [],
        filteredBooks: [],
        editingBookId: null,
        selectedBookId: null,
        expandedBots: new Set(),
        messageCache: {},
        allMessages: {},
        currentUser: null,
        bookSearchContext: { query: '', bookId: null },
        botTags: [],
        botWebhooks: [],
        users: [],
        sessions: [],
        selectedMessages: {},
        messagePageState: {},
        scrollListenerAttached: {},
        lensFilterState: {},
        roadmapGlossary: {
            platforms: {
                coming_soon: ['Telegram', 'Line', 'Signal', 'WeChat']
            }
        }
    };

    return {
        get: (key) => _state[key],
        set: (key, value) => { _state[key] = value; },
        
        getBooks: () => _state.books,
        setBooks: (books) => { _state.books = books; },
        pushBook: (book) => { _state.books.push(book); },
        
        getFilteredBooks: () => _state.filteredBooks,
        setFilteredBooks: (books) => { _state.filteredBooks = books; },
        
        getEditingBookId: () => _state.editingBookId,
        setEditingBookId: (id) => { _state.editingBookId = id; },
        
        getSelectedBookId: () => _state.selectedBookId,
        setSelectedBookId: (id) => { _state.selectedBookId = id; },
        
        getExpandedBots: () => _state.expandedBots,
        addExpandedBot: (id) => { _state.expandedBots.add(id); },
        removeExpandedBot: (id) => { _state.expandedBots.delete(id); },
        clearExpandedBots: () => { _state.expandedBots.clear(); },
        
        getMessageCache: () => _state.messageCache,
        setMessageCache: (cache) => { _state.messageCache = cache; },
        getCachedMessages: (bookId) => _state.messageCache[bookId],
        setCachedMessages: (bookId, messages) => { _state.messageCache[bookId] = messages; },
        
        getAllMessages: () => _state.allMessages,
        setAllMessages: (messages) => { _state.allMessages = messages; },
        getMessage: (id) => _state.allMessages[id],
        setMessage: (id, message) => { _state.allMessages[id] = message; },
        
        getCurrentUser: () => _state.currentUser,
        setCurrentUser: (user) => { _state.currentUser = user; },
        
        getBookSearchContext: () => _state.bookSearchContext,
        setBookSearchContext: (context) => { _state.bookSearchContext = context; },
        
        getBotTags: () => _state.botTags,
        setBotTags: (tags) => { _state.botTags = tags; },
        addBotTag: (tag) => { _state.botTags.push(tag); },
        removeBotTag: (tag) => { _state.botTags = _state.botTags.filter(t => t !== tag); },
        
        getBotWebhooks: () => _state.botWebhooks,
        setBotWebhooks: (webhooks) => { _state.botWebhooks = webhooks; },
        
        getUsers: () => _state.users,
        setUsers: (users) => { _state.users = users; },
        
        getSessions: () => _state.sessions,
        setSessions: (sessions) => { _state.sessions = sessions; },
        
        getSelectedMessages: () => _state.selectedMessages,
        setSelectedMessages: (selected) => { _state.selectedMessages = selected; },
        getSelectedMessagesForBook: (bookId) => _state.selectedMessages[bookId],
        setSelectedMessagesForBook: (bookId, set) => { _state.selectedMessages[bookId] = set; },
        
        getMessagePageState: () => _state.messagePageState,
        setMessagePageState: (state) => { _state.messagePageState = state; },
        getBookPageState: (bookId) => _state.messagePageState[bookId],
        setBookPageState: (bookId, state) => { _state.messagePageState[bookId] = state; },
        
        getScrollListenerAttached: () => _state.scrollListenerAttached,
        setScrollListenerForBook: (bookId, attached) => { _state.scrollListenerAttached[bookId] = attached; },
        
        getLensFilterState: () => _state.lensFilterState,
        getLensFilterForBook: (bookId) => _state.lensFilterState[bookId],
        setLensFilterForBook: (bookId, filter) => { _state.lensFilterState[bookId] = filter; },
        
        getRoadmapGlossary: () => _state.roadmapGlossary,
        
        reset: () => {
            _state.books = [];
            _state.filteredBooks = [];
            _state.editingBookId = null;
            _state.selectedBookId = null;
            _state.expandedBots = new Set();
            _state.messageCache = {};
            _state.allMessages = {};
            _state.currentUser = null;
            _state.bookSearchContext = { query: '', bookId: null };
            _state.botTags = [];
            _state.botWebhooks = [];
            _state.users = [];
            _state.sessions = [];
            _state.selectedMessages = {};
            _state.messagePageState = {};
            _state.scrollListenerAttached = {};
            _state.lensFilterState = {};
        }
    };
})();

console.log('📦 Nyan.StateService loaded');
