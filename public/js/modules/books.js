/**
 * @fileoverview Books Module - CRUD operations and state management for books
 * @module Nyan.BooksModule
 */

window.Nyan = window.Nyan || {};

/**
 * @typedef {Object} Book
 * @property {string} fractal_id - Unique book identifier (hash)
 * @property {string} name - Book display name
 * @property {string} [platform] - Platform type (whatsapp, discord, etc)
 * @property {string} [contact_info] - Join code for Twilio activation
 * @property {string} [status] - Connection status
 * @property {boolean} [is_shared] - Whether book is shared with current user
 * @property {string} [owner_email] - Email of book owner (for shared books)
 */

/**
 * @typedef {Object} ApiResult
 * @property {boolean} success - Whether the operation succeeded
 * @property {string} [error] - Error message if failed
 */

/**
 * @typedef {Object} BooksResult
 * @property {boolean} success
 * @property {Book[]} [books] - Array of books on success
 * @property {string} [error]
 */

/**
 * @typedef {Object} BookResult
 * @property {boolean} success
 * @property {Book} [book] - Single book on success
 * @property {string} [error]
 * @property {Object} [data] - Additional response data
 */

/**
 * @typedef {Object} SharesResult
 * @property {boolean} success
 * @property {Array<{email: string, created_at: string}>} [shares]
 * @property {string} [error]
 */

/**
 * @typedef {Object} SearchResult
 * @property {boolean} success
 * @property {string[]} [matchingBooks] - Array of matching book IDs
 * @property {boolean} [partial] - Whether results are partial
 * @property {string} [reason] - Reason for partial results
 * @property {string} [error]
 */

window.Nyan.BooksModule = (function() {
    const API_PATHS = {
        BOOKS: '/api/books',
        BOOK: (id) => `/api/books/${id}`,
        BOOK_SHARES: (id) => `/api/books/${id}/shares`,
        BOOK_SHARE: (id) => `/api/books/${id}/share`,
        BOOK_SHARE_REVOKE: (id, email) => `/api/books/${id}/share/${encodeURIComponent(email)}`,
        BOOK_RELINK: (id) => `/api/books/${id}/relink`,
        SEARCH: (term, bookIds) => `/api/search?term=${encodeURIComponent(term)}&bookIds=${bookIds.join(',')}`
    };

    const _S = window.Nyan.StateService;
    const _D = () => window.Nyan.DataSync;
    
    /**
     * Removes duplicate books by fractal_id, keeping first occurrence
     * @param {Book[]} rawBooks - Array of books that may contain duplicates
     * @returns {Book[]} Array of unique books
     */
    function deduplicateBooks(rawBooks) {
        const uniqueBooksMap = new Map();
        rawBooks.forEach(book => {
            if (book.fractal_id && !uniqueBooksMap.has(book.fractal_id)) {
                uniqueBooksMap.set(book.fractal_id, book);
            }
        });
        return Array.from(uniqueBooksMap.values());
    }

    /**
     * Fetches all books and syncs local state.
     * @param {boolean} [quiet=false] - Suppress non-error console output (for background refresh)
     * @returns {Promise<BooksResult>} Result with books array on success
     */
    async function loadBooks(quiet = false) {
        try {
            const response = await window.authFetch(API_PATHS.BOOKS);
            if (!response.ok) {
                console.error('❌ Book fetch failed:', response.status, response.statusText);
                return { success: false, error: response.statusText };
            }
            const data = await response.json();
            const rawBooks = data.books || data || [];
            const uniqueBooks = deduplicateBooks(rawBooks);

            _S.setBooks(uniqueBooks);
            _S.setFilteredBooks(uniqueBooks);

            if (!quiet) {
                console.log('📦 Books response:', data);
                console.log(`✅ Loaded ${uniqueBooks.length} unique books (${rawBooks.length} total from API)`);
            }
            return { success: true, books: uniqueBooks };
        } catch (error) {
            console.error('❌ Error loading books:', error.message || error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Creates a new book
     * @param {Object} bookData - Book creation data
     * @param {string} bookData.name - Book name (required)
     * @param {string} [bookData.platform] - Platform type
     * @returns {Promise<BookResult>} Result with created book on success
     */
    async function createBook(bookData) {
        try {
            const response = await window.authFetch(API_PATHS.BOOKS, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(bookData)
            });
            
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                return { success: false, error: errorData.error || response.statusText, data: errorData };
            }
            
            const book = await response.json();
            return { success: true, book };
        } catch (error) {
            console.error('Error creating book:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Updates an existing book
     * @param {string} fractalId - Book's fractal_id
     * @param {Object} bookData - Fields to update
     * @param {string} [bookData.name] - New book name
     * @returns {Promise<BookResult>} Result with updated book on success
     */
    async function updateBook(fractalId, bookData) {
        try {
            const response = await window.authFetch(API_PATHS.BOOK(fractalId), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(bookData)
            });
            
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                return { success: false, error: errorData.error || response.statusText, data: errorData };
            }
            
            const book = await response.json();
            
            const books = _S.getBooks();
            const index = books.findIndex(b => b.fractal_id === fractalId);
            if (index !== -1) {
                books[index] = book;
                _S.setBooks(books);
                _S.setFilteredBooks(books);
            }
            
            return { success: true, book };
        } catch (error) {
            console.error('Error updating book:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Deletes a book and removes it from state
     * @param {string} fractalId - Book's fractal_id
     * @returns {Promise<ApiResult>} Success/failure result
     */
    async function deleteBook(fractalId) {
        try {
            console.log('🗑️ DELETE request for book:', fractalId);
            const response = await window.authFetch(API_PATHS.BOOK(fractalId), {
                method: 'DELETE'
            });
            
            console.log('🗑️ DELETE response status:', response.status, response.ok);
            
            if (!response.ok) {
                const error = await response.json().catch(() => ({}));
                return { success: false, status: response.status, error: error.error || 'Delete failed' };
            }
            
            const books = _S.getBooks().filter(b => b.fractal_id !== fractalId);
            const filteredBooks = _S.getFilteredBooks().filter(b => b.fractal_id !== fractalId);
            _S.setBooks(books);
            _S.setFilteredBooks(filteredBooks);
            
            if (_S.getSelectedBookId() === fractalId) {
                _S.setSelectedBookId(null);
            }
            
            return { success: true };
        } catch (error) {
            console.error('🗑️ Error deleting book:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Loads all shares for a book
     * @param {string} fractalId - Book's fractal_id
     * @returns {Promise<SharesResult>} Result with shares array on success
     */
    async function loadBookShares(fractalId) {
        try {
            const response = await window.authFetch(API_PATHS.BOOK_SHARES(fractalId));
            if (!response.ok) throw new Error('Failed to load shares');
            const data = await response.json();
            return { success: true, shares: data.shares || [] };
        } catch (error) {
            console.error('Error loading shares:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Shares a book with another user by email
     * @param {string} fractalId - Book's fractal_id
     * @param {string} email - Email address to share with
     * @returns {Promise<ApiResult & {alreadyShared?: boolean}>} Result with alreadyShared flag
     */
    async function shareBook(fractalId, email) {
        if (!email || !email.includes('@')) {
            return { success: false, error: 'Invalid email address' };
        }
        
        try {
            const response = await window.authFetch(API_PATHS.BOOK_SHARE(fractalId), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email })
            });
            
            const data = await response.json();
            
            if (!response.ok) {
                return { success: false, error: data.error || 'Failed to share' };
            }
            
            return { success: true, alreadyShared: data.alreadyShared };
        } catch (error) {
            console.error('Error sharing book:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Revokes a book share from a user
     * @param {string} fractalId - Book's fractal_id
     * @param {string} email - Email address to revoke access from
     * @returns {Promise<ApiResult>} Success/failure result
     */
    async function revokeBookShare(fractalId, email) {
        try {
            const response = await window.authFetch(API_PATHS.BOOK_SHARE_REVOKE(fractalId, email), {
                method: 'DELETE'
            });
            
            if (!response.ok) {
                const data = await response.json();
                return { success: false, error: data.error || 'Failed to revoke' };
            }
            
            return { success: true };
        } catch (error) {
            console.error('Error revoking share:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Initiates WhatsApp relink flow for a book
     * @param {string} bookId - Book's fractal_id
     * @returns {Promise<ApiResult & {data?: Object}>} Result with response data on success
     */
    async function relinkWhatsApp(bookId) {
        try {
            const response = await window.authFetch(API_PATHS.BOOK_RELINK(bookId), {
                method: 'POST'
            });
            if (!response.ok) {
                const error = await response.json();
                return { success: false, error: error.error || 'Failed to relink' };
            }
            const data = await response.json();
            return { success: true, data };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Searches messages across multiple books
     * @param {string} term - Search term
     * @param {string[]} bookIds - Array of book fractal_ids to search
     * @returns {Promise<SearchResult>} Result with matching book IDs
     */
    async function searchBooks(term, bookIds) {
        try {
            const response = await window.authFetch(API_PATHS.SEARCH(term, bookIds));
            if (!response.ok) return { success: false };
            const data = await response.json();
            return { success: true, matchingBooks: data.matchingBooks || [], partial: data.partial, reason: data.reason };
        } catch (error) {
            console.error('Error searching books:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Gets a book from local state by fractal_id
     * @param {string} fractalId - Book's fractal_id
     * @returns {Book|undefined} The book if found, undefined otherwise
     */
    function getBook(fractalId) {
        return _S.getBooks().find(b => b.fractal_id === fractalId);
    }

    /**
     * Sets the currently selected book ID in state
     * @param {string|null} fractalId - Book's fractal_id or null to deselect
     * @returns {void}
     */
    function selectBook(fractalId) {
        _S.setSelectedBookId(fractalId);
    }

    return {
        loadBooks,
        createBook,
        updateBook,
        deleteBook,
        loadBookShares,
        shareBook,
        revokeBookShare,
        relinkWhatsApp,
        searchBooks,
        getBook,
        selectBook,
        deduplicateBooks
    };
})();

console.log('📚 Nyan.BooksModule loaded');
