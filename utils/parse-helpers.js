const EMPTY_TABLE_ROW_REGEX = /^[\s\-:]+$/;

function cleanMarkdownJson(str) {
  return str.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
}

module.exports = { EMPTY_TABLE_ROW_REGEX, cleanMarkdownJson };
