declare module '*.geojson' {
  const value: any;
  export default value;
}

declare module '*.csv?raw' {
  const value: string;
  export default value;
}
