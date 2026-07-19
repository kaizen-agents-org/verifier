pub fn is_valid_identifier(value: &str) -> bool {
    !value.is_empty() && value.chars().all(|character| character.is_ascii_alphanumeric())
}

#[cfg(test)]
mod tests {
    use super::is_valid_identifier;

    #[test]
    fn rejects_empty_identifier() {
        assert!(!is_valid_identifier(""));
    }
}
