// What makes a password acceptable.
//
// The rules follow what actually gets accounts broken into rather than the
// old "one capital, one symbol" recipe (which produces "Password@123"):
//   - long enough: 10 characters or more. Length does more than variety;
//   - not one of the passwords attackers try first, however it is dressed up
//     ("password123", "P@ssw0rd2024", "qwertyuiop");
//   - not built from the account's own email address;
//   - not only digits: a phone number or a date of birth is the first thing
//     someone who knows the student would try.
// bcrypt reads no further than 72 bytes, so anything longer is refused rather
// than silently cut short.

export const MIN_LENGTH = 10;
const MAX_BYTES = 72;

// The words behind the most-used passwords. A password is refused when,
// stripped of digits, symbols and "leet" spelling, it is one of these, a
// repeat of one, or two of them joined.
const COMMON_WORDS = new Set([
  "password", "passwort", "pass", "passcode", "qwerty", "qwertyuiop", "qwert", "asdfgh", "asdfghjkl", "zxcvbn", "zxcvbnm",
  "letmein", "welcome", "admin", "administrator", "login", "iloveyou", "loveyou", "monkey", "dragon", "master", "sunshine",
  "princess", "football", "cricket", "baseball", "superman", "batman", "computer", "internet", "secret", "changeme",
  "default", "guest", "test", "testing", "student", "college", "school", "india", "krishna", "ganesh", "sairam",
  "mindatlas", "atlas", "abc", "abcd", "abcdef", "abcdefgh", "aaa", "user", "hello", "trustno",
]);

const LEET = { "@": "a", "4": "a", "0": "o", "1": "i", "!": "i", "3": "e", "$": "s", "5": "s", "7": "t" };

// "P@ssw0rd123!" and "Password@123" -> "password": lower case, digits and
// symbols at either end dropped, then leet letters undone inside the word.
function baseWord(password) {
  const core = password.toLowerCase().replace(/^[^a-z]+/, "").replace(/[^a-z]+$/, "");
  return [...core].map((ch) => LEET[ch] ?? ch).join("").replace(/[^a-z]/g, "");
}

const isSequence = (s) => {
  if (s.length < 6) return false;
  const steps = new Set();
  for (let i = 1; i < s.length; i++) steps.add(s.charCodeAt(i) - s.charCodeAt(i - 1));
  return steps.size === 1 && [1, -1, 0].includes([...steps][0]);
};

function isCommon(password) {
  const word = baseWord(password);
  if (!word) return false;
  if (COMMON_WORDS.has(word)) return true;
  // the same word twice ("passwordpassword"), or two common words joined
  for (let i = 3; i <= word.length - 3; i++) {
    if (COMMON_WORDS.has(word.slice(0, i)) && COMMON_WORDS.has(word.slice(i))) return true;
  }
  // a common word with a little added ("mypassword", "newpassword", "qwertyabc")
  for (const common of COMMON_WORDS) {
    if (common.length >= 6 && word.includes(common) && word.length - common.length <= 3) return true;
  }
  return false;
}

/**
 * Why this password is not acceptable, as a sentence for the student, or
 * null when it is fine. `email` is the account's address.
 */
export function passwordProblem(password, { email = "" } = {}) {
  if (typeof password !== "string" || !password) return "a password is required";
  if (password.length < MIN_LENGTH) return `the password must be at least ${MIN_LENGTH} characters`;
  if (Buffer.byteLength(password, "utf8") > MAX_BYTES) return `the password is too long - use at most ${MAX_BYTES} characters`;
  if (/^\d+$/.test(password)) return "the password cannot be only digits - a phone number or a date is easy to guess";
  if (new Set(password.toLowerCase()).size < 5) return "the password repeats too few characters - mix more in";
  const digits = password.replace(/\D/g, "");
  if (isSequence(password.toLowerCase()) || (isSequence(digits) && digits.length >= password.length - 2)) {
    return "the password is a simple sequence - choose something harder to guess";
  }
  if (isCommon(password)) return "that password is one of the most commonly used - choose something harder to guess";
  const name = String(email).split("@")[0].toLowerCase().replace(/[^a-z0-9]/g, "");
  if (name.length >= 4 && password.toLowerCase().replace(/[^a-z0-9]/g, "").includes(name)) {
    return "the password should not contain your email name";
  }
  return null;
}
