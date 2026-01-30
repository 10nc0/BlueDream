/**
 * Code Context Registry - Maps design/architecture topics to source files
 * 
 * When users ask about internal design, implementation details, or how
 * systems work, this module provides the actual source code as context
 * to prevent LLM hallucination.
 */

const fs = require('fs');
const path = require('path');

const CODE_CONTEXT_REGISTRY = {
  'psi-ema': {
    description: 'Ψ-EMA three-dimensional time series oscillator',
    keywords: ['psi ema', 'ψ-ema', 'psi-ema', 'psiema', 'theta z r', 'phase anomaly convergence', 'golden ratio oscillator', 'phi orbital', 'φ-derived'],
    files: ['utils/psi-EMA.js'],
    sections: [
      { start: 1, end: 200, label: 'Core theory and constants' },
      { start: 200, end: 400, label: 'EMA calculations' }
    ]
  },
  'pipeline': {
    description: '7-stage AI processing pipeline (S-1 to S6)',
    keywords: ['pipeline', 'state machine', 'orchestrator', 's0', 's1', 's2', 's3', 's4', 's5', 's6', 'groqfirst', 'audit pass'],
    files: ['utils/pipeline-orchestrator.js'],
    sections: [
      { start: 1, end: 100, label: 'Pipeline architecture overview' },
      { start: 96, end: 200, label: 'PipelineOrchestrator class' }
    ]
  },
  'nyan-protocol': {
    description: 'NYAN Protocol system prompts and reasoning principles',
    keywords: ['nyan protocol', 'nyan system', 'system prompt', 'reasoning principles'],
    files: ['prompts/nyan-protocol.js'],
    sections: [
      { start: 1, end: 200, label: 'Full protocol' }
    ]
  },
  'preflight': {
    description: 'Preflight routing and mode detection',
    keywords: ['preflight', 'mode detection', 'routing', 'query classification'],
    files: ['utils/preflight-router.js'],
    sections: [
      { start: 1, end: 150, label: 'Router logic and modes' }
    ]
  },
  'audit': {
    description: 'Two-pass verification and audit protocol',
    keywords: ['audit', 'verification', 'two pass', 'hallucination check', 'audit protocol'],
    files: ['utils/two-pass-verification.js', 'prompts/audit-protocol.js'],
    sections: [
      { start: 1, end: 200, label: 'Audit logic' }
    ]
  },
  'seed-metric': {
    description: 'Seed Metric for historical comparison',
    keywords: ['seed metric', 'historical comparison', 'baseline', 'seed calculator'],
    files: ['utils/seed-metric-calculator.js', 'prompts/seed-metric.js'],
    sections: [
      { start: 1, end: 150, label: 'Seed metric system' }
    ]
  },
  'data-package': {
    description: 'DataPackage immutable stage data carrier',
    keywords: ['data package', 'datapackage', 'stage data', 'immutable carrier'],
    files: ['utils/data-package.js'],
    sections: [
      { start: 1, end: 150, label: 'DataPackage class' }
    ]
  },
  'context-extractor': {
    description: 'Context extraction and memory management',
    keywords: ['context extract', 'memory', 'phi-8', 'φ-8', 'sliding window'],
    files: ['utils/context-extractor.js'],
    sections: [
      { start: 1, end: 150, label: 'Context extraction' }
    ]
  },
  'attachment': {
    description: 'Attachment ingestion and vision processing',
    keywords: ['attachment', 'file upload', 'vision', 'image analysis', 'document parsing'],
    files: ['utils/attachment-ingestion.js', 'utils/attachment-cascade.js'],
    sections: [
      { start: 1, end: 100, label: 'Attachment handling' }
    ]
  },
  'personality': {
    description: 'Personality formatting and cleanup',
    keywords: ['personality', 'formatting', 'cleanup', 'nyan tone', 'executive formatter'],
    files: ['prompts/personality-format.js', 'utils/executive-formatter.js'],
    sections: [
      { start: 1, end: 150, label: 'Personality system' }
    ]
  },
  'financial-physics': {
    description: 'Financial physics and conservation laws',
    keywords: ['financial physics', 'conservation', 'balance sheet', 'pathogen detection'],
    files: ['utils/financial-physics.js'],
    sections: [
      { start: 1, end: 200, label: 'Financial physics theory' }
    ]
  },
  'code-audit': {
    description: 'Code audit mode for security analysis',
    keywords: ['code audit', 'security audit', 'code analysis', 'vulnerability'],
    files: ['prompts/code-analysis.js'],
    sections: [
      { start: 1, end: 100, label: 'Code audit prompts' }
    ]
  },
  'legal': {
    description: 'Legal document analysis system',
    keywords: ['legal', 'contract', 'agreement', 'legal analysis'],
    files: ['prompts/legal-analysis.js'],
    sections: [
      { start: 1, end: 150, label: 'Legal analysis prompts' }
    ]
  },
  'forex': {
    description: 'Forex currency fetching and analysis',
    keywords: ['forex', 'currency', 'exchange rate', 'fx'],
    files: ['utils/forex-fetcher.js'],
    sections: [
      { start: 1, end: 150, label: 'Forex fetcher' }
    ]
  },
  'stock': {
    description: 'Stock data fetching',
    keywords: ['stock fetcher', 'yahoo finance', 'price data'],
    files: ['utils/stock-fetcher.js'],
    sections: [
      { start: 1, end: 150, label: 'Stock fetcher' }
    ]
  }
};

const DESIGN_QUESTION_PATTERNS = [
  /how\s+(?:does|do|is)\s+(?:the\s+)?(.+?)\s+(?:work|implemented|designed|built|function)/i,
  /(?:explain|describe)\s+(?:the\s+)?(.+?)\s+(?:architecture|design|implementation|system|code)/i,
  /what\s+(?:is|are)\s+(?:the\s+)?(?:code|source|implementation)\s+(?:for|of|behind)\s+(.+)/i,
  /show\s+(?:me\s+)?(?:the\s+)?(?:code|source|implementation)\s+(?:for|of)\s+(.+)/i,
  /where\s+(?:is|are)\s+(?:the\s+)?(.+?)\s+(?:defined|implemented|coded)/i,
  /(?:can\s+you\s+)?(?:explain|show)\s+(?:the\s+)?(.+?)\s+(?:source|code)/i,
  /how\s+did\s+(?:you|nyan)\s+(?:implement|build|design)\s+(.+)/i,
  /what\s+(?:is|are)\s+(?:the\s+)?design\s+(?:of|for|behind)\s+(.+)/i,
  /technical\s+(?:details?|overview)\s+(?:of|for|about)\s+(.+)/i,
  /(?:tell\s+me\s+)?about\s+(?:the\s+)?(.+?)\s+(?:module|system|component)/i,
  /what\s+(?:files?|modules?)\s+(?:contain|have|implement)\s+(.+)/i,
  /internals?\s+(?:of|for)\s+(.+)/i,
];

function isDesignQuestion(query) {
  if (!query) return false;
  const normalized = query.toLowerCase().trim();
  
  for (const pattern of DESIGN_QUESTION_PATTERNS) {
    if (pattern.test(normalized)) {
      return true;
    }
  }
  
  const designKeywords = ['how does', 'how is', 'implementation', 'architecture', 'design', 'source code', 'codebase', 'how you built', 'technical details', 'internals'];
  const hasDesignKeyword = designKeywords.some(kw => normalized.includes(kw));
  
  const topicKeywords = Object.values(CODE_CONTEXT_REGISTRY)
    .flatMap(topic => topic.keywords);
  const hasTopic = topicKeywords.some(kw => normalized.includes(kw.toLowerCase()));
  
  return hasDesignKeyword && hasTopic;
}

function findRelevantTopics(query) {
  if (!query) return [];
  const normalized = query.toLowerCase().trim();
  const matches = [];
  
  for (const [topicId, topic] of Object.entries(CODE_CONTEXT_REGISTRY)) {
    const keywordMatch = topic.keywords.some(kw => normalized.includes(kw.toLowerCase()));
    if (keywordMatch) {
      matches.push({ topicId, topic, score: keywordMatch ? 1 : 0.5 });
    }
  }
  
  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, 2);
}

function readFileSection(filePath, startLine, endLine) {
  try {
    const fullPath = path.resolve(process.cwd(), filePath);
    if (!fs.existsSync(fullPath)) {
      return `[File not found: ${filePath}]`;
    }
    
    const content = fs.readFileSync(fullPath, 'utf8');
    const lines = content.split('\n');
    const section = lines.slice(startLine - 1, endLine).join('\n');
    return section;
  } catch (err) {
    return `[Error reading ${filePath}: ${err.message}]`;
  }
}

function buildCodeContext(query, maxTokens = 4000) {
  const topics = findRelevantTopics(query);
  if (topics.length === 0) {
    return null;
  }
  
  const contextParts = [];
  let estimatedTokens = 0;
  const tokensPerChar = 0.25;
  
  for (const { topicId, topic } of topics) {
    if (estimatedTokens > maxTokens) break;
    
    contextParts.push(`\n=== ${topic.description.toUpperCase()} ===`);
    contextParts.push(`Topic: ${topicId}`);
    contextParts.push(`Files: ${topic.files.join(', ')}`);
    
    for (const file of topic.files) {
      if (estimatedTokens > maxTokens) break;
      
      const sections = topic.sections || [{ start: 1, end: 150, label: 'Main' }];
      
      for (const section of sections) {
        if (estimatedTokens > maxTokens) break;
        
        const code = readFileSection(file, section.start, section.end);
        const codeTokens = code.length * tokensPerChar;
        
        if (estimatedTokens + codeTokens > maxTokens) {
          const remainingChars = (maxTokens - estimatedTokens) / tokensPerChar;
          const truncated = code.slice(0, Math.max(500, remainingChars));
          contextParts.push(`\n--- ${file} (${section.label}, truncated) ---`);
          contextParts.push('```javascript');
          contextParts.push(truncated + '\n... [truncated for brevity]');
          contextParts.push('```');
          estimatedTokens = maxTokens;
        } else {
          contextParts.push(`\n--- ${file} (${section.label}) ---`);
          contextParts.push('```javascript');
          contextParts.push(code);
          contextParts.push('```');
          estimatedTokens += codeTokens;
        }
      }
    }
  }
  
  if (contextParts.length === 0) {
    return null;
  }
  
  return {
    context: contextParts.join('\n'),
    topics: topics.map(t => t.topicId),
    instruction: `IMPORTANT: You are answering a question about Nyanbook's internal architecture. Below is the ACTUAL SOURCE CODE. Use ONLY this code to answer. Do NOT hallucinate or guess implementation details. Quote the code directly when relevant.`
  };
}

function getSystemContextForDesign(query) {
  if (!isDesignQuestion(query)) {
    return null;
  }
  
  const codeContext = buildCodeContext(query);
  if (!codeContext) {
    return null;
  }
  
  return {
    systemMessage: `${codeContext.instruction}\n\n${codeContext.context}`,
    topics: codeContext.topics
  };
}

module.exports = {
  isDesignQuestion,
  findRelevantTopics,
  buildCodeContext,
  getSystemContextForDesign,
  CODE_CONTEXT_REGISTRY
};
