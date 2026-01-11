/**
 * Unit tests for Nyan.BooksModule
 * Run in browser console or via test runner
 */

(function() {
    const tests = [];
    let passed = 0;
    let failed = 0;

    function test(name, fn) {
        tests.push({ name, fn });
    }

    function assertEqual(actual, expected, msg = '') {
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            throw new Error(`${msg}\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`);
        }
    }

    function assertTrue(condition, msg = '') {
        if (!condition) {
            throw new Error(msg || 'Expected true but got false');
        }
    }

    function assertFalse(condition, msg = '') {
        if (condition) {
            throw new Error(msg || 'Expected false but got true');
        }
    }

    test('deduplicateBooks: removes duplicates by fractal_id', () => {
        const _B = window.Nyan.BooksModule;
        const input = [
            { fractal_id: 'abc123', name: 'Book A' },
            { fractal_id: 'def456', name: 'Book B' },
            { fractal_id: 'abc123', name: 'Book A Duplicate' }
        ];
        const result = _B.deduplicateBooks(input);
        assertEqual(result.length, 2, 'Should have 2 unique books');
        assertEqual(result[0].name, 'Book A', 'Should keep first occurrence');
        assertEqual(result[1].name, 'Book B');
    });

    test('deduplicateBooks: handles empty array', () => {
        const _B = window.Nyan.BooksModule;
        const result = _B.deduplicateBooks([]);
        assertEqual(result, [], 'Empty input should return empty array');
    });

    test('deduplicateBooks: handles books without fractal_id', () => {
        const _B = window.Nyan.BooksModule;
        const input = [
            { fractal_id: 'abc123', name: 'Valid Book' },
            { name: 'No ID Book' },
            { fractal_id: null, name: 'Null ID Book' },
            { fractal_id: '', name: 'Empty ID Book' }
        ];
        const result = _B.deduplicateBooks(input);
        assertEqual(result.length, 1, 'Should only include books with valid fractal_id');
        assertEqual(result[0].name, 'Valid Book');
    });

    test('deduplicateBooks: preserves book properties', () => {
        const _B = window.Nyan.BooksModule;
        const input = [
            { fractal_id: 'abc123', name: 'Book A', platform: 'whatsapp', status: 'active' }
        ];
        const result = _B.deduplicateBooks(input);
        assertEqual(result[0].platform, 'whatsapp');
        assertEqual(result[0].status, 'active');
    });

    test('deduplicateBooks: handles large arrays efficiently', () => {
        const _B = window.Nyan.BooksModule;
        const input = [];
        for (let i = 0; i < 1000; i++) {
            input.push({ fractal_id: `id${i % 100}`, name: `Book ${i}` });
        }
        const start = performance.now();
        const result = _B.deduplicateBooks(input);
        const elapsed = performance.now() - start;
        assertEqual(result.length, 100, 'Should have 100 unique books');
        assertTrue(elapsed < 100, `Should complete in <100ms, took ${elapsed}ms`);
    });

    test('getBook: returns book when found', () => {
        const _S = window.Nyan.StateService;
        const _B = window.Nyan.BooksModule;
        const testBooks = [
            { fractal_id: 'test123', name: 'Test Book' },
            { fractal_id: 'test456', name: 'Another Book' }
        ];
        _S.setBooks(testBooks);
        const result = _B.getBook('test123');
        assertEqual(result.name, 'Test Book');
    });

    test('getBook: returns undefined when not found', () => {
        const _S = window.Nyan.StateService;
        const _B = window.Nyan.BooksModule;
        _S.setBooks([{ fractal_id: 'exists', name: 'Exists' }]);
        const result = _B.getBook('nonexistent');
        assertEqual(result, undefined);
    });

    test('selectBook: updates selected book ID', () => {
        const _S = window.Nyan.StateService;
        const _B = window.Nyan.BooksModule;
        _B.selectBook('newSelection');
        assertEqual(_S.getSelectedBookId(), 'newSelection');
        _B.selectBook(null);
        assertEqual(_S.getSelectedBookId(), null);
    });

    test('loadBooks: success path deduplicates and updates state', async () => {
        const _S = window.Nyan.StateService;
        const _B = window.Nyan.BooksModule;
        const originalAuthFetch = window.authFetch;
        
        const mockBooks = [
            { fractal_id: 'book1', name: 'Book 1' },
            { fractal_id: 'book2', name: 'Book 2' },
            { fractal_id: 'book1', name: 'Duplicate' }
        ];
        
        window.authFetch = async () => ({
            ok: true,
            json: async () => ({ books: mockBooks })
        });
        
        try {
            const result = await _B.loadBooks();
            assertTrue(result.success, 'Should succeed');
            assertEqual(result.books.length, 2, 'Should deduplicate');
            assertEqual(_S.getBooks().length, 2, 'State should have deduplicated books');
            assertEqual(_S.getFilteredBooks().length, 2, 'FilteredBooks should match');
        } finally {
            window.authFetch = originalAuthFetch;
        }
    });

    test('loadBooks: handles API error response', async () => {
        const _B = window.Nyan.BooksModule;
        const originalAuthFetch = window.authFetch;
        
        window.authFetch = async () => ({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error'
        });
        
        try {
            const result = await _B.loadBooks();
            assertFalse(result.success, 'Should fail');
            assertEqual(result.error, 'Internal Server Error');
        } finally {
            window.authFetch = originalAuthFetch;
        }
    });

    test('loadBooks: handles network exception', async () => {
        const _B = window.Nyan.BooksModule;
        const originalAuthFetch = window.authFetch;
        
        window.authFetch = async () => {
            throw new Error('Network error');
        };
        
        try {
            const result = await _B.loadBooks();
            assertFalse(result.success, 'Should fail');
            assertEqual(result.error, 'Network error');
        } finally {
            window.authFetch = originalAuthFetch;
        }
    });

    test('loadBooks: handles empty response gracefully', async () => {
        const _S = window.Nyan.StateService;
        const _B = window.Nyan.BooksModule;
        const originalAuthFetch = window.authFetch;
        
        window.authFetch = async () => ({
            ok: true,
            json: async () => ({ books: [] })
        });
        
        try {
            const result = await _B.loadBooks();
            assertTrue(result.success, 'Should succeed');
            assertEqual(result.books, [], 'Should return empty array');
            assertEqual(_S.getBooks(), [], 'State should be empty');
        } finally {
            window.authFetch = originalAuthFetch;
        }
    });

    test('loadBooks: handles missing books property in response', async () => {
        const _S = window.Nyan.StateService;
        const _B = window.Nyan.BooksModule;
        const originalAuthFetch = window.authFetch;
        
        window.authFetch = async () => ({
            ok: true,
            json: async () => ([{ fractal_id: 'direct', name: 'Direct Array' }])
        });
        
        try {
            const result = await _B.loadBooks();
            assertTrue(result.success, 'Should succeed with direct array');
            assertEqual(result.books.length, 1);
        } finally {
            window.authFetch = originalAuthFetch;
        }
    });

    async function runTests() {
        console.log('🧪 Running BooksModule tests...\n');
        
        for (const { name, fn } of tests) {
            try {
                await fn();
                passed++;
                console.log(`✅ ${name}`);
            } catch (error) {
                failed++;
                console.error(`❌ ${name}`);
                console.error(`   ${error.message}`);
            }
        }
        
        console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
        return { passed, failed };
    }

    window.Nyan = window.Nyan || {};
    window.Nyan.BooksModuleTests = { runTests };
    
    console.log('🧪 BooksModule tests loaded. Run with: Nyan.BooksModuleTests.runTests()');
})();
