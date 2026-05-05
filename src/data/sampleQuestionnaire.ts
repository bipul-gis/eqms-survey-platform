// Sample questionnaire data for MAMATA survey
export const sampleQuestionnaire = {
  title: "MAMATA Household Survey",
  description: "Comprehensive household survey for urban development planning",
  version: "1.0",
  isActive: true,
  questions: [
    {
      id: "q1",
      type: "text",
      question: "What is the name of the household head?",
      required: true,
      placeholder: "Enter full name"
    },
    {
      id: "q2",
      type: "number",
      question: "How many people live in this household?",
      required: true,
      validation: { min: 1, max: 20 }
    },
    {
      id: "q3",
      type: "select",
      question: "What is the primary source of income for this household?",
      required: true,
      options: ["Government Job", "Private Job", "Business", "Agriculture", "Daily Wage Labor", "Remittances", "Other"]
    },
    {
      id: "q4",
      type: "radio",
      question: "Does this household own the property they live in?",
      required: true,
      options: ["Yes, fully owned", "Yes, partially owned", "No, rented", "No, living with relatives"]
    },
    {
      id: "q5",
      type: "checkbox",
      question: "Which of the following facilities are available in this household? (Select all that apply)",
      required: false,
      options: ["Electricity", "Piped Water", "Sanitary Toilet", "Gas Connection", "Television", "Refrigerator", "Mobile Phone", "Computer/Internet"]
    },
    {
      id: "q6",
      type: "text",
      question: "What are the main challenges faced by this household?",
      required: false,
      placeholder: "Describe any issues with housing, employment, health, education, etc."
    },
    {
      id: "q7",
      type: "radio",
      question: "Are there any children under 18 in this household?",
      required: true,
      options: ["Yes", "No"]
    },
    {
      id: "q8",
      type: "number",
      question: "How many children under 18 are enrolled in school?",
      required: false,
      validation: { min: 0 }
    },
    {
      id: "q9",
      type: "select",
      question: "What is the highest level of education completed by the household head?",
      required: false,
      options: ["No formal education", "Primary (Class 1-5)", "Secondary (Class 6-10)", "Higher Secondary (Class 11-12)", "Graduate", "Post-graduate", "Technical/Vocational"]
    },
    {
      id: "q10",
      type: "text",
      question: "Any additional comments or observations?",
      required: false,
      placeholder: "Note any important observations about the household or area"
    }
  ]
};