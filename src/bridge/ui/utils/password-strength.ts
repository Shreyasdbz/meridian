// @meridian/bridge/ui — Password strength calculator (Phase 7.2)
// Pure function with no dependencies. Used by the onboarding password step.

export type StrengthLevel = 'weak' | 'fair' | 'good' | 'strong';

export interface PasswordStrength {
  level: StrengthLevel;
  score: number;
  feedback: string;
}

const MIN_LENGTH = 8;

/**
 * Calculate password strength and return a score, level, and feedback hint.
 *
 * Scoring:
 * - Length contribution (0-40): 5 points per char up to 8 chars
 * - Character diversity (0-40): +10 each for lowercase, uppercase, digits, symbols
 * - Bonus (0-20): length > 12 gets +10, length > 16 gets +10 more
 * - Levels: weak (0-29), fair (30-49), good (50-69), strong (70+)
 */
export function calculatePasswordStrength(password: string): PasswordStrength {
  if (password.length === 0) {
    return { level: 'weak', score: 0, feedback: 'Enter a password' };
  }

  if (password.length < MIN_LENGTH) {
    const charsNeeded = MIN_LENGTH - password.length;
    return {
      level: 'weak',
      score: Math.min(password.length * 5, 29),
      feedback: `At least ${String(charsNeeded)} more character${charsNeeded === 1 ? '' : 's'} needed`,
    };
  }

  // Length contribution: 5 points per char, max 40
  const lengthScore = Math.min(password.length * 5, 40);

  // Character diversity: +10 for each class present
  const hasLowercase = /[a-z]/.test(password);
  const hasUppercase = /[A-Z]/.test(password);
  const hasDigits = /\d/.test(password);
  const hasSymbols = /[^a-zA-Z0-9]/.test(password);

  let diversityScore = 0;
  if (hasLowercase) diversityScore += 10;
  if (hasUppercase) diversityScore += 10;
  if (hasDigits) diversityScore += 10;
  if (hasSymbols) diversityScore += 10;

  // Bonus for longer passwords
  let bonusScore = 0;
  if (password.length > 12) bonusScore += 10;
  if (password.length > 16) bonusScore += 10;

  const score = Math.min(lengthScore + diversityScore + bonusScore, 100);

  const level = scoreToLevel(score);
  const feedback = buildFeedback(level, {
    hasLowercase,
    hasUppercase,
    hasDigits,
    hasSymbols,
    length: password.length,
  });

  return { level, score, feedback };
}

function scoreToLevel(score: number): StrengthLevel {
  if (score >= 70) return 'strong';
  if (score >= 50) return 'good';
  if (score >= 30) return 'fair';
  return 'weak';
}

interface CharClasses {
  hasLowercase: boolean;
  hasUppercase: boolean;
  hasDigits: boolean;
  hasSymbols: boolean;
  length: number;
}

function buildFeedback(level: StrengthLevel, classes: CharClasses): string {
  if (level === 'strong') {
    return 'Great password!';
  }

  const suggestions: string[] = [];

  if (!classes.hasUppercase) suggestions.push('uppercase letters');
  if (!classes.hasLowercase) suggestions.push('lowercase letters');
  if (!classes.hasDigits) suggestions.push('numbers');
  if (!classes.hasSymbols) suggestions.push('symbols');

  if (suggestions.length > 0) {
    return `Add ${suggestions.join(', ')} to strengthen`;
  }

  if (classes.length <= 12) {
    return 'Try making it longer';
  }

  return 'Good password';
}
