window.Nyan = window.Nyan || {};

window.Nyan.BooksModule = (function() {
    const _S = window.Nyan.StateService;
    const _D = () => window.Nyan.DataSync;
    
    function deduplicateBooks(rawBooks) {
        const uniqueBooksMap = new Map();
        rawBooks.forEach(book => {
            if (book.fractal_id && !uniqueBooksMap.has(book.fractal_id)) {
                uniqueBooksMap.set(book.fractal_id, book);
            }
        });
        return Array.from(uniqueBooksMap.values());
    }

    async function loadBooks() {
        try {
            const response = await window.authFetch('/api/books');
            if (!response.ok) {
                console.error('❌ Book fetch failed:', response.status, response.statusText);
                return { success: false, error: response.statusText };
            }
            const data = await response.json();
            console.log('📦 Books response:', data);
            const rawBooks = data.books || data || [];
            const uniqueBooks = deduplicateBooks(rawBooks);
            
            _S.setBooks(uniqueBooks);
            _S.setFilteredBooks(uniqueBooks);
            
            console.log(`✅ Loaded ${uniqueBooks.length} unique books (${rawBooks.length} total from API)`);
            return { success: true, books: uniqueBooks };
        } catch (error) {
            console.error('❌ Error loading books:', error.message || error);
            return { success: false, error: error.message };
        }
    }
    
    async function loadBooksQuietly() {
        try {
            const response = await window.authFetch('/api/books');
            const data = await response.json();
            const rawBooks = data.books || data || [];
            const uniqueBooks = deduplicateBooks(rawBooks);
            
            _S.setBooks(uniqueBooks);
            _S.setFilteredBooks(uniqueBooks);
            return { success: true, books: uniqueBooks };
        } catch (error) {
            console.error('Error loading books:', error);
            return { success: false, error: error.message };
        }
    }

    async function createBook(bookData) {
        try {
            const response = await window.authFetch('/api/books', {
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

    async function updateBook(fractalId, bookData) {
        try {
            const response = await window.authFetch(`/api/books/${fractalId}`, {
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

    async function deleteBook(fractalId) {
        try {
            console.log('🗑️ DELETE request for book:', fractalId);
            const response = await window.authFetch(`/api/books/${fractalId}`, {
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

    async function loadBookShares(fractalId) {
        try {
            const response = await window.authFetch(`/api/books/${fractalId}/shares`);
            if (!response.ok) throw new Error('Failed to load shares');
            const data = await response.json();
            return { success: true, shares: data.shares || [] };
        } catch (error) {
            console.error('Error loading shares:', error);
            return { success: false, error: error.message };
        }
    }

    async function shareBook(fractalId, email) {
        if (!email || !email.includes('@')) {
            return { success: false, error: 'Invalid email address' };
        }
        
        try {
            const response = await window.authFetch(`/api/books/${fractalId}/share`, {
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

    async function revokeBookShare(fractalId, email) {
        try {
            const response = await window.authFetch(`/api/books/${fractalId}/share/${encodeURIComponent(email)}`, {
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

    async function relinkWhatsApp(bookId) {
        try {
            const response = await window.authFetch(`/api/books/${bookId}/relink`, {
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

    async function searchBooks(term, bookIds) {
        try {
            const response = await window.authFetch(`/api/search?term=${encodeURIComponent(term)}&bookIds=${bookIds.join(',')}`);
            if (!response.ok) return { success: false };
            const data = await response.json();
            return { success: true, matchingBooks: data.matchingBooks || [], partial: data.partial, reason: data.reason };
        } catch (error) {
            console.error('Error searching books:', error);
            return { success: false, error: error.message };
        }
    }

    function getBook(fractalId) {
        return _S.getBooks().find(b => b.fractal_id === fractalId);
    }

    function selectBook(fractalId) {
        _S.setSelectedBookId(fractalId);
    }

    return {
        loadBooks,
        loadBooksQuietly,
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
