-- Add phone_number to all tenant schemas
ALTER TABLE tenant_5.users ADD COLUMN IF NOT EXISTS phone_number TEXT UNIQUE;
ALTER TABLE tenant_6.users ADD COLUMN IF NOT EXISTS phone_number TEXT UNIQUE;
ALTER TABLE tenant_7.users ADD COLUMN IF NOT EXISTS phone_number TEXT UNIQUE;
ALTER TABLE tenant_8.users ADD COLUMN IF NOT EXISTS phone_number TEXT UNIQUE;
ALTER TABLE tenant_9.users ADD COLUMN IF NOT EXISTS phone_number TEXT UNIQUE;
ALTER TABLE tenant_10.users ADD COLUMN IF NOT EXISTS phone_number TEXT UNIQUE;
ALTER TABLE tenant_11.users ADD COLUMN IF NOT EXISTS phone_number TEXT UNIQUE;
ALTER TABLE tenant_12.users ADD COLUMN IF NOT EXISTS phone_number TEXT UNIQUE;
ALTER TABLE tenant_13.users ADD COLUMN IF NOT EXISTS phone_number TEXT UNIQUE;
ALTER TABLE tenant_14.users ADD COLUMN IF NOT EXISTS phone_number TEXT UNIQUE;
ALTER TABLE tenant_15.users ADD COLUMN IF NOT EXISTS phone_number TEXT UNIQUE;

-- Create phone_to_book tables
CREATE TABLE IF NOT EXISTS tenant_5.phone_to_book (id SERIAL PRIMARY KEY, phone_number TEXT REFERENCES tenant_5.users(phone_number) ON DELETE CASCADE, book_id INTEGER NOT NULL, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(), UNIQUE(phone_number, book_id));
CREATE TABLE IF NOT EXISTS tenant_6.phone_to_book (id SERIAL PRIMARY KEY, phone_number TEXT REFERENCES tenant_6.users(phone_number) ON DELETE CASCADE, book_id INTEGER NOT NULL, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(), UNIQUE(phone_number, book_id));
CREATE TABLE IF NOT EXISTS tenant_7.phone_to_book (id SERIAL PRIMARY KEY, phone_number TEXT REFERENCES tenant_7.users(phone_number) ON DELETE CASCADE, book_id INTEGER NOT NULL, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(), UNIQUE(phone_number, book_id));
CREATE TABLE IF NOT EXISTS tenant_8.phone_to_book (id SERIAL PRIMARY KEY, phone_number TEXT REFERENCES tenant_8.users(phone_number) ON DELETE CASCADE, book_id INTEGER NOT NULL, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(), UNIQUE(phone_number, book_id));
CREATE TABLE IF NOT EXISTS tenant_9.phone_to_book (id SERIAL PRIMARY KEY, phone_number TEXT REFERENCES tenant_9.users(phone_number) ON DELETE CASCADE, book_id INTEGER NOT NULL, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(), UNIQUE(phone_number, book_id));
CREATE TABLE IF NOT EXISTS tenant_10.phone_to_book (id SERIAL PRIMARY KEY, phone_number TEXT REFERENCES tenant_10.users(phone_number) ON DELETE CASCADE, book_id INTEGER NOT NULL, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(), UNIQUE(phone_number, book_id));
CREATE TABLE IF NOT EXISTS tenant_11.phone_to_book (id SERIAL PRIMARY KEY, phone_number TEXT REFERENCES tenant_11.users(phone_number) ON DELETE CASCADE, book_id INTEGER NOT NULL, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(), UNIQUE(phone_number, book_id));
CREATE TABLE IF NOT EXISTS tenant_12.phone_to_book (id SERIAL PRIMARY KEY, phone_number TEXT REFERENCES tenant_12.users(phone_number) ON DELETE CASCADE, book_id INTEGER NOT NULL, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(), UNIQUE(phone_number, book_id));
CREATE TABLE IF NOT EXISTS tenant_13.phone_to_book (id SERIAL PRIMARY KEY, phone_number TEXT REFERENCES tenant_13.users(phone_number) ON DELETE CASCADE, book_id INTEGER NOT NULL, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(), UNIQUE(phone_number, book_id));
CREATE TABLE IF NOT EXISTS tenant_14.phone_to_book (id SERIAL PRIMARY KEY, phone_number TEXT REFERENCES tenant_14.users(phone_number) ON DELETE CASCADE, book_id INTEGER NOT NULL, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(), UNIQUE(phone_number, book_id));
CREATE TABLE IF NOT EXISTS tenant_15.phone_to_book (id SERIAL PRIMARY KEY, phone_number TEXT REFERENCES tenant_15.users(phone_number) ON DELETE CASCADE, book_id INTEGER NOT NULL, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(), UNIQUE(phone_number, book_id));

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_phone_to_book_phone ON tenant_5.phone_to_book(phone_number);
CREATE INDEX IF NOT EXISTS idx_phone_to_book_book ON tenant_5.phone_to_book(book_id);
CREATE INDEX IF NOT EXISTS idx_phone_to_book_phone ON tenant_6.phone_to_book(phone_number);
CREATE INDEX IF NOT EXISTS idx_phone_to_book_book ON tenant_6.phone_to_book(book_id);
CREATE INDEX IF NOT EXISTS idx_phone_to_book_phone ON tenant_7.phone_to_book(phone_number);
CREATE INDEX IF NOT EXISTS idx_phone_to_book_book ON tenant_7.phone_to_book(book_id);
CREATE INDEX IF NOT EXISTS idx_phone_to_book_phone ON tenant_8.phone_to_book(phone_number);
CREATE INDEX IF NOT EXISTS idx_phone_to_book_book ON tenant_8.phone_to_book(book_id);
CREATE INDEX IF NOT EXISTS idx_phone_to_book_phone ON tenant_9.phone_to_book(phone_number);
CREATE INDEX IF NOT EXISTS idx_phone_to_book_book ON tenant_9.phone_to_book(book_id);
CREATE INDEX IF NOT EXISTS idx_phone_to_book_phone ON tenant_10.phone_to_book(phone_number);
CREATE INDEX IF NOT EXISTS idx_phone_to_book_book ON tenant_10.phone_to_book(book_id);
CREATE INDEX IF NOT EXISTS idx_phone_to_book_phone ON tenant_11.phone_to_book(phone_number);
CREATE INDEX IF NOT EXISTS idx_phone_to_book_book ON tenant_11.phone_to_book(book_id);
CREATE INDEX IF NOT EXISTS idx_phone_to_book_phone ON tenant_12.phone_to_book(phone_number);
CREATE INDEX IF NOT EXISTS idx_phone_to_book_book ON tenant_12.phone_to_book(book_id);
CREATE INDEX IF NOT EXISTS idx_phone_to_book_phone ON tenant_13.phone_to_book(phone_number);
CREATE INDEX IF NOT EXISTS idx_phone_to_book_book ON tenant_13.phone_to_book(book_id);
CREATE INDEX IF NOT EXISTS idx_phone_to_book_phone ON tenant_14.phone_to_book(phone_number);
CREATE INDEX IF NOT EXISTS idx_phone_to_book_book ON tenant_14.phone_to_book(book_id);
CREATE INDEX IF NOT EXISTS idx_phone_to_book_phone ON tenant_15.phone_to_book(phone_number);
CREATE INDEX IF NOT EXISTS idx_phone_to_book_book ON tenant_15.phone_to_book(book_id);
