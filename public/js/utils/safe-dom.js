'use strict';

const SafeDOM = {
    escapeHtml(text) {
        if (text === null || text === undefined) return '';
        const str = String(text);
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    },

    createElement(tag, attrs = {}, children = []) {
        const el = document.createElement(tag);
        
        for (const [key, value] of Object.entries(attrs)) {
            if (key === 'className') {
                el.className = value;
            } else if (key === 'style' && typeof value === 'object') {
                Object.assign(el.style, value);
            } else if (key.startsWith('on') && typeof value === 'function') {
                el.addEventListener(key.slice(2).toLowerCase(), value);
            } else if (key === 'dataset' && typeof value === 'object') {
                Object.assign(el.dataset, value);
            } else if (value !== null && value !== undefined && value !== false) {
                el.setAttribute(key, value);
            }
        }
        
        if (Array.isArray(children)) {
            children.forEach(child => {
                if (child === null || child === undefined) return;
                if (typeof child === 'string' || typeof child === 'number') {
                    el.appendChild(document.createTextNode(String(child)));
                } else if (child instanceof Node) {
                    el.appendChild(child);
                }
            });
        } else if (typeof children === 'string' || typeof children === 'number') {
            el.textContent = String(children);
        }
        
        return el;
    },

    text(content) {
        return document.createTextNode(content == null ? '' : String(content));
    },

    clearElement(el) {
        while (el.firstChild) {
            el.removeChild(el.firstChild);
        }
    },

    replaceChildren(el, ...children) {
        this.clearElement(el);
        children.flat().forEach(child => {
            if (child === null || child === undefined) return;
            if (typeof child === 'string' || typeof child === 'number') {
                el.appendChild(document.createTextNode(String(child)));
            } else if (child instanceof Node) {
                el.appendChild(child);
            }
        });
    },

    setTextContent(el, text) {
        el.textContent = text == null ? '' : String(text);
    },

    appendText(el, text) {
        el.appendChild(document.createTextNode(text == null ? '' : String(text)));
    },

    fragment(...children) {
        const frag = document.createDocumentFragment();
        children.flat().forEach(child => {
            if (child === null || child === undefined) return;
            if (typeof child === 'string' || typeof child === 'number') {
                frag.appendChild(document.createTextNode(String(child)));
            } else if (child instanceof Node) {
                frag.appendChild(child);
            }
        });
        return frag;
    }
};

if (typeof window !== 'undefined') {
    window.SafeDOM = SafeDOM;
}
